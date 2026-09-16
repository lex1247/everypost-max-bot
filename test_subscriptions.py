"""Subscription terms, renewal receipts and queue safety without external payments."""
import json
import tempfile
import time
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch
from zoneinfo import ZoneInfo

from core import Store
from posting import Posting, packed
from subscriptions import PLANS, Subscriptions, SubscriptionExpired, add_months
from migration import export_data, import_data
import test_client_onboarding as customer_fixture
from test_posting import signed
from web_server import calendar_action


def stamp(value):
    return datetime.fromisoformat(value).replace(tzinfo=ZoneInfo('Europe/Moscow')).timestamp()


class SubscriptionStateTests(unittest.TestCase):
    def setUp(self):
        self.s = Store(':memory:')
        self.p = Posting(self.s)
        self.d = self.p.connect_channel(456, -1001, 'Клиент', 123)
        self.terms = self.p.subscriptions

    def tearDown(self):
        self.s.db.close()

    def change(self, kind, value, event='tg:123:1', **kw):
        return self.terms.change(123, 123, self.d, kind, value, event, **kw)

    def test_catalog_matches_existing_max_periods_and_prices(self):
        self.assertEqual([(p[0], p[1]) for p in PLANS], [(1, 299), (3, 849), (6, 1599), (12, 2999)])

    def test_calendar_months_handle_month_end_leap_year_and_year_boundary(self):
        for start, months, end in (
            ('2026-01-31T18:30', 1, '2026-02-28T18:30'),
            ('2028-01-31T18:30', 1, '2028-02-29T18:30'),
            ('2028-02-29T18:30', 12, '2029-02-28T18:30'),
            ('2026-12-31T18:30', 3, '2027-03-31T18:30')):
            with self.subTest(start=start):
                self.assertEqual(add_months(stamp(start), months), stamp(end))

    def test_first_grant_and_renewal_keep_remaining_time(self):
        now = stamp('2026-09-16T15:00')
        first = self.change('grant', 1, now=now)
        second = self.change('grant', 3, event='tg:123:2', now=now+86400)
        self.assertEqual(first['expires_at'], stamp('2026-10-16T15:00'))
        self.assertEqual(second['expires_at'], stamp('2027-01-16T15:00'))
        self.assertEqual(second['mode'], 'launch')

    def test_expired_renewal_starts_at_current_time(self):
        self.change('grant', 1, now=stamp('2025-01-01T10:00'))
        receipt = self.change('grant', 1, event='tg:123:2', now=stamp('2026-09-16T15:00'))
        self.assertEqual(receipt['expires_at'], stamp('2026-10-16T15:00'))

    def test_replayed_command_returns_original_receipt_without_extra_time(self):
        first = self.change('grant', 1)
        second = self.change('grant', 3, event='tg:123:2')
        self.assertEqual(self.change('grant', 1), first)
        self.assertEqual(self.terms.get(self.d), second)
        self.assertEqual(len(self.s.rows('SELECT * FROM ed_subscription_events')), 2)

    def test_replayed_id_with_changed_arguments_is_rejected(self):
        self.change('grant', 1)
        other = self.p.connect_channel(789, -1002, 'Другой', 123)
        for d, kind, value in ((self.d, 'grant', 3), (self.d, 'mode', 'launch'), (other, 'grant', 1)):
            with self.subTest(d=d, kind=kind), self.assertRaises(ValueError):
                self.terms.change(123, 123, d, kind, value, 'tg:123:1')
        self.assertIsNone(self.terms.get(other))
        self.assertEqual(len(self.s.rows('SELECT * FROM ed_subscription_events')), 1)

    def test_only_service_admin_can_grant_or_change_mode(self):
        for kind, value in (('grant', 1), ('mode', 'term')):
            with self.assertRaisesRegex(ValueError, 'администратор сервиса'):
                self.terms.change(456, 123, self.d, kind, value, 'tg:456:1')
        self.assertIsNone(self.terms.get(self.d))

    def test_invalid_months_event_destination_and_max_channel_rejected(self):
        for months in (0, 2, 13, -1, True, '1'):
            with self.subTest(months=months), self.assertRaises(ValueError):
                self.change('grant', months)
        with self.assertRaises(ValueError): self.change('grant', 1, event='')
        max_d = self.s.add_destination('max', '-200', 'MAX')
        for d in (max_d, 9999):
            with self.assertRaises(ValueError):
                self.terms.change(123, 123, d, 'grant', 1, 'tg:123:2')
        self.assertFalse(self.s.rows('SELECT * FROM ed_subscription_events'))

    def test_launch_access_is_preserved_without_a_grant_and_after_expiry(self):
        self.terms.require_publication(self.d, time.time()+200*86400)
        self.change('grant', 1, now=stamp('2025-01-01T10:00'))
        self.terms.require_publication(self.d)
        self.assertEqual(self.terms.get(self.d)['mode'], 'launch')

    def test_term_mode_must_be_explicit_and_requires_unexpired_grant(self):
        with self.assertRaises(ValueError): self.change('mode', 'term')
        self.change('grant', 1, now=stamp('2025-01-01T10:00'))
        with self.assertRaises(ValueError): self.change('mode', 'term', event='tg:123:2')
        self.change('grant', 1, event='tg:123:3')
        self.change('mode', 'term', event='tg:123:4')
        self.change('grant', 3, event='tg:123:5')
        self.assertEqual(self.terms.get(self.d)['mode'], 'term')

    def test_expiry_boundary_and_publication_time_limit(self):
        expiry = self.change('grant', 1)['expires_at']
        self.change('mode', 'term', event='tg:123:2')
        self.terms.require_publication(self.d, expiry-1)
        with self.assertRaises(SubscriptionExpired): self.terms.require_publication(self.d, expiry)
        with patch('subscriptions.time.time', return_value=expiry):
            with self.assertRaises(SubscriptionExpired): self.terms.require_publication(self.d)

    def test_journal_failure_rolls_back_term_extension(self):
        before = self.change('grant', 1)
        execute = self.s.db.execute
        def fail(sql, args=()):
            if sql.startswith('INSERT INTO ed_subscription_events'): raise RuntimeError('journal write failed')
            return execute(sql, args)
        with patch.object(self.s.db, 'execute', side_effect=fail), self.assertRaises(RuntimeError):
            self.change('grant', 3, event='tg:123:2')
        self.assertEqual(self.terms.get(self.d), before)

    def test_restart_and_migration_keep_mode_dates_and_replay_receipts(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)/'source.sqlite3'
            source = Store(path); p = Posting(source)
            d = p.connect_channel(456, -1001, 'Клиент', 123)
            granted = p.subscriptions.change(123, 123, d, 'grant', 3, 'tg:123:1')
            mode = p.subscriptions.change(123, 123, d, 'mode', 'term', 'tg:123:2')
            source.db.close()
            source = Store(path); p = Posting(source)
            self.assertEqual(p.subscriptions.get(d), mode)
            source.db.close()
            target = Store(':memory:'); p = Posting(target)
            try:
                import_data(target, export_data(path))
                self.assertEqual(p.subscriptions.get(d), mode)
                self.assertEqual(p.subscriptions.change(123, 123, d, 'grant', 3, 'tg:123:1'), granted)
                self.assertEqual(p.subscriptions.get(d), mode)
            finally: target.db.close()


class SubscriptionFlowTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = customer_fixture.CustomerFlowTests.asyncSetUp
    asyncTearDown = customer_fixture.CustomerFlowTests.asyncTearDown
    telegram = customer_fixture.CustomerFlowTests.telegram
    connect = customer_fixture.CustomerFlowTests.connect
    message = customer_fixture.CustomerFlowTests.message
    draft = customer_fixture.CustomerFlowTests.draft

    async def limited(self):
        d = await self.connect()
        self.p.subscriptions.change(123, 123, d, 'grant', 1, 'tg:123:1')
        self.p.subscriptions.change(123, 123, d, 'mode', 'term', 'tg:123:2')
        return d

    def expire(self, d):
        self.s.run('UPDATE ed_subscriptions SET expires_at=? WHERE destination=?', (time.time()-1, d))

    def renew(self, d):
        return self.p.subscriptions.change(123, 123, d, 'grant', 1, 'tg:123:3')

    async def send(self, post):
        with patch('app.asyncio.sleep', new_callable=AsyncMock):
            await self.app.deliver({'id': post['delivery']})

    def publications(self):
        return [c for c in self.app.tg.call_args_list if c.args[0].startswith('send') and str(c.kwargs.get('chat_id','')).startswith('-')]

    async def test_subscription_menu_works_without_channels_or_lost_edit_session(self):
        await self.e.handle(self.message(789, '/subscription'))
        self.assertIn('пока нет', self.e.say.call_args.args[1])
        await self.e.callback(789, 'ed:sub:plans')
        self.assertIn('299 ₽', self.e.say.call_args.args[1])
        d = await self.connect()
        await self.e.callback(456, f'ed:channel:new:{d}')
        session = self.p.session(456)
        await self.e.handle(self.message(456, '/subscription'))
        await self.e.callback(456, f'ed:sub:channel:{d}')
        self.assertEqual(self.p.session(456), session)
        self.assertNotIn('/subscriptiongrant', self.e.say.call_args.args[1])

    async def test_foreign_customer_cannot_view_or_grant_channel_subscription(self):
        d = await self.limited()
        await self.connect(789, '@other_channel')
        with self.assertRaises(ValueError): await self.e.callback(789, f'ed:sub:channel:{d}')
        before = self.p.subscriptions.get(d)
        for actor in (456, 789):
            with self.assertRaises(ValueError):
                await self.e.handle(self.message(actor, f'/subscriptiongrant {d} 12', message_id=10))
        self.assertEqual(self.p.subscriptions.get(d), before)

    async def test_service_grant_replayed_inbox_updates_do_not_extend_twice(self):
        d = await self.connect()
        message = self.message(123, f'/subscriptiongrant {d} 1', message_id=10)
        for update_id in (71, 71, 72):
            self.app.accept_update({'update_id': update_id, **message})
            await self.app.process_updates()
        self.assertEqual(len(self.s.rows('SELECT * FROM ed_subscription_events')), 1)
        self.assertEqual(self.p.subscriptions.get(d)['months'], 1)
        self.assertIn('Оплата не проводилась', self.e.say.call_args.args[1])

    async def test_forwarded_caption_other_bot_and_missing_message_id_cannot_grant(self):
        d = await self.connect()
        await self.e.handle(self.message(123, f'/subscriptiongrant {d} 1', forward_origin={'type': 'user'}, message_id=10))
        await self.e.handle(self.message(123, caption=f'/subscriptiongrant {d} 1', photo=[{'file_id': 'p'}], message_id=11))
        await self.e.handle(self.message(123, f'/subscriptiongrant@another_bot {d} 1', message_id=12))
        with self.assertRaises(ValueError): await self.e.handle(self.message(123, f'/subscriptiongrant {d} 1'))
        self.assertIsNone(self.p.subscriptions.get(d))

    async def test_expired_customer_can_keep_and_edit_drafts_but_not_publish(self):
        d = await self.limited(); self.expire(d)
        post = await self.draft(456, d, video=True)
        await self.e.callback(456, f'ed:text:{post["id"]}:1')
        await self.e.handle(self.message(456, 'Новая подпись'))
        post = self.p.post(post['id'])
        with self.assertRaises(SubscriptionExpired):
            await self.e.callback(456, f'ed:publish:{post["id"]}:{post["revision"]}')
        self.assertEqual(self.p.post(post['id'])['text'], 'Новая подпись')
        self.assertFalse(self.s.rows('SELECT * FROM deliveries'))

    async def test_calendar_and_text_reject_time_beyond_subscription_without_changing_post(self):
        d = await self.limited(); post = await self.draft(456, d)
        self.s.run('UPDATE ed_subscriptions SET expires_at=? WHERE destination=?', (time.time()+3600, d))
        await self.e.calendar(456, post, 'schedule')
        nonce = self.s.rows('SELECT nonce FROM ed_calendar')[0][0]
        date = datetime.now(ZoneInfo('Europe/Moscow'))+timedelta(hours=2)
        with self.assertRaises(SubscriptionExpired):
            await calendar_action(self.e, 'save', {'initData': signed(456), 'nonce': nonce, 'mode': 'schedule',
                'day': date.strftime('%Y%m%d'), 'hour': date.hour, 'minute': date.minute})
        with self.assertRaises(SubscriptionExpired):
            await self.e.handle(self.message(456, date.strftime('%d.%m.%Y %H:%M')))
        self.assertEqual(self.p.post(post['id'])['state'], 'draft')
        self.assertEqual(self.s.rows('SELECT receipt FROM ed_calendar')[0][0], '')

    async def test_expired_due_post_is_held_and_renewal_does_not_publish_it(self):
        d = await self.limited(); post = await self.draft(456, d)
        post = self.p.change(post, 456, state='scheduled', publish_at=time.time()-1)
        self.expire(d)
        await self.e.tick()
        self.assertEqual(self.p.post(post['id'])['state'], 'held')
        self.renew(d); await self.e.tick()
        self.assertFalse(self.s.rows('SELECT * FROM deliveries'))
        self.assertEqual(self.p.post(post['id'])['state'], 'held')

    async def test_queued_post_waits_for_explicit_resume_and_old_button_cannot_repeat(self):
        d = await self.limited(); post = self.p.enqueue(await self.draft(456, d), 456)
        self.expire(d); self.app.tg.reset_mock()
        await self.send(post)
        held = self.p.post(post['id'])
        self.assertEqual(held['state'], 'subscription_hold')
        self.renew(d); await self.e.tick(); await self.send(held)
        self.assertFalse(self.publications())
        data = f'ed:subscription_resume:{held["id"]}:{held["revision"]}'
        await self.e.callback(456, data)
        with self.assertRaises(ValueError): await self.e.callback(456, data)
        await self.send(self.p.post(post['id']))
        self.assertEqual(len(self.publications()), 1)
        self.assertEqual(len(self.s.rows('SELECT * FROM deliveries')), 1)

    async def test_renewal_before_worker_notices_expiry_still_holds_backlog(self):
        d = await self.limited()
        queued = self.p.enqueue(await self.draft(456, d), 456)
        due = self.p.change(await self.draft(456, d), 456, state='scheduled', publish_at=time.time()-1)
        future = self.p.set_time(await self.draft(456, d), 456, 'schedule', time.time()+3600)
        self.expire(d)
        self.renew(d)
        self.app.tg.reset_mock()
        await self.e.tick(); await self.send(queued)
        self.assertFalse(self.publications())
        self.assertEqual(self.p.post(queued['id'])['state'], 'subscription_hold')
        self.assertEqual(self.p.post(due['id'])['state'], 'held')
        self.assertEqual(self.p.post(future['id'])['state'], 'scheduled')

    async def test_switching_back_to_launch_does_not_flush_expired_queue(self):
        d = await self.limited(); post = self.p.enqueue(await self.draft(456, d), 456)
        self.expire(d)
        self.p.subscriptions.change(123, 123, d, 'mode', 'launch', 'tg:123:3')
        self.app.tg.reset_mock(); await self.send(post)
        self.assertEqual(self.p.post(post['id'])['state'], 'subscription_hold')
        self.assertFalse(self.publications())

    async def test_unpublished_hold_can_return_to_draft_without_active_term(self):
        d = await self.limited(); post = self.p.enqueue(await self.draft(456, d), 456)
        self.expire(d); await self.send(post)
        held = self.p.post(post['id'])
        await self.e.callback(456, f'ed:subscription_draft:{held["id"]}:{held["revision"]}')
        draft = self.p.post(post['id'])
        self.assertEqual(draft['state'], 'draft')
        self.assertEqual(self.s.rows('SELECT status FROM deliveries')[0][0], 'cancelled')
        self.renew(d)
        self.p.set_time(draft, 456, 'schedule', time.time()+3600)
        self.assertEqual(self.p.post(post['id'])['state'], 'scheduled')

    async def test_partially_sent_post_resumes_only_pending_parts_after_renewal(self):
        d = await self.limited()
        self.s.run('UPDATE ed_channels SET style=? WHERE destination=?',
            (packed({'buttons': [{'text': 'Ссылка', 'url': 'https://example.com'}]}), d))
        media = {'gallery': [{'type': 'photo', 'tg_file_id': 'p1'}, {'type': 'photo', 'tg_file_id': 'p2'}]}
        post = self.p.enqueue(self.p.new(d, 456, 'Подпись', media), 456)
        original = self.telegram
        async def expire_after_album(method, **payload):
            if method == 'sendMediaGroup':
                self.expire(d)
                return [{'message_id': 11}, {'message_id': 12}]
            return await original(method, **payload)
        self.app.tg = AsyncMock(side_effect=expire_after_album)
        await self.send(post)
        held = self.p.post(post['id'])
        self.assertEqual(held['state'], 'subscription_hold')
        with self.assertRaises(ValueError): self.p.subscriptions.resume(held, 456, draft=True)
        self.renew(d)
        await self.e.callback(456, f'ed:subscription_resume:{held["id"]}:{held["revision"]}')
        await self.send(self.p.post(post['id']))
        self.assertEqual([c.args[0] for c in self.publications()], ['sendMediaGroup', 'sendMessage'])
        parts = self.s.rows('SELECT status,remote FROM delivery_parts ORDER BY part')
        self.assertEqual([p['status'] for p in parts], ['sent', 'sent'])
        self.assertEqual(json.loads(parts[0]['remote']), ['11', '12'])

    async def test_expiry_while_preparing_media_prevents_external_send(self):
        d = await self.limited(); post = self.p.enqueue(await self.draft(456, d), 456)
        prepare = self.app.prepare_part
        async def expire(*args):
            result = await prepare(*args); self.expire(d); return result
        self.app.prepare_part = expire; self.app.tg.reset_mock()
        await self.send(post)
        self.assertFalse(self.publications())
        self.assertEqual(self.p.post(post['id'])['state'], 'subscription_hold')

    async def test_foreign_and_revoked_editor_cannot_resume_held_delivery(self):
        d = await self.limited()
        self.s.run('INSERT INTO ed_admins VALUES(?,?)', (d, 321))
        self.roles[-1001, 321] = {'status': 'administrator', 'can_post_messages': True}
        post = self.p.enqueue(self.p.new(d, 321, 'Пост редактора', {}), 321)
        self.expire(d); await self.send(post); self.renew(d)
        self.s.run('DELETE FROM ed_admins WHERE actor=321')
        held = self.p.post(post['id'])
        for actor in (789, 321):
            with self.assertRaises(ValueError):
                await self.e.callback(actor, f'ed:subscription_resume:{held["id"]}:{held["revision"]}')
        self.assertEqual(self.p.post(post['id'])['state'], 'subscription_hold')

    async def test_ambiguous_send_remains_unknown_when_term_expires(self):
        d = await self.limited(); post = self.p.enqueue(await self.draft(456, d), 456)
        original = self.telegram
        async def ambiguous(method, **payload):
            if method == 'sendMessage' and str(payload.get('chat_id','')).startswith('-'):
                self.expire(d); raise TimeoutError()
            return await original(method, **payload)
        self.app.tg = AsyncMock(side_effect=ambiguous)
        await self.send(post); await self.e.tick()
        self.renew(d); await self.e.tick(); await self.send(self.p.post(post['id']))
        self.assertEqual(len(self.publications()), 1)
        self.assertEqual(self.p.post(post['id'])['state'], 'unknown')

    async def test_expired_grant_in_launch_mode_does_not_block_publication(self):
        d = await self.connect()
        self.p.subscriptions.change(123, 123, d, 'grant', 1, 'tg:123:1', now=stamp('2025-01-01T10:00'))
        post = self.p.enqueue(await self.draft(456, d), 456)
        self.app.tg.reset_mock(); await self.send(post)
        self.assertEqual(len(self.publications()), 1)

    async def test_expired_term_keeps_auto_deletion_available(self):
        d = await self.limited(); post = self.p.enqueue(await self.draft(456, d), 456)
        await self.send(post); await self.e.tick()
        self.s.run('UPDATE ed_posts SET delete_at=? WHERE id=?', (time.time()-1, post['id']))
        self.expire(d)
        original = self.telegram
        async def deleting(method, **payload):
            if method == 'deleteMessage': return True
            return await original(method, **payload)
        self.app.tg = AsyncMock(side_effect=deleting)
        await self.e.delete_due()
        self.assertEqual(self.p.post(post['id'])['state'], 'deleted')

    async def test_expired_auto_delete_time_on_hold_can_be_disabled_before_resume(self):
        d = await self.limited(); post = self.p.enqueue(await self.draft(456, d), 456)
        self.expire(d); await self.send(post); self.renew(d)
        self.s.run('UPDATE ed_posts SET delete_at=? WHERE id=?', (time.time()-1, post['id']))
        held = self.p.post(post['id'])
        with self.assertRaisesRegex(ValueError, 'автоудаления'):
            self.p.subscriptions.resume(held, 456)
        await self.e.callback(456, f'ed:delete:{held["id"]}:{held["revision"]}')
        self.assertEqual(self.p.session(456)['mode'], 'delete')
        await self.e.callback(456, f'ed:undelete:{held["id"]}:{held["revision"]}')
        held = self.p.post(post['id'])
        await self.e.callback(456, f'ed:subscription_resume:{held["id"]}:{held["revision"]}')
        self.assertEqual(self.p.post(post['id'])['state'], 'queued')

    async def test_hold_notification_is_once_and_post_visible_in_drafts(self):
        d = await self.limited(); post = self.p.enqueue(await self.draft(456, d), 456)
        self.expire(d); await self.send(post)
        self.e.say.reset_mock(); await self.e.tick(); await self.e.tick()
        self.assertEqual(self.e.say.call_count, 1)
        await self.e.listing(456, d, 'draft')
        self.assertIn(f'ed:open:{post["id"]}', str(self.e.say.call_args))

    async def test_automatic_source_is_held_and_only_explicitly_resumed(self):
        d = await self.limited()
        source = self.s.add_source('tg', '-2000', 'Источник', 10)
        self.s.run('INSERT INTO routes VALUES(?,?)', (source, d))
        self.s.set_route_mode(source, d, 'original')
        self.s.ingest(source, [(11, 'Пост источника', 'https://t.me/example/11')], 11)
        delivery = self.s.rows('SELECT * FROM deliveries')[0]
        self.expire(d); self.app.tg.reset_mock()
        await self.app.deliver(delivery)
        self.assertEqual(self.s.rows('SELECT status FROM deliveries')[0][0], 'subscription_hold')
        self.assertIn('subscription_hold', await self.app.command('/errors'))
        self.renew(d); await self.app.deliver(delivery)
        self.assertFalse(self.publications())
        await self.app.command(f'/resolve {delivery["id"]} retry')
        with patch('app.asyncio.sleep', new_callable=AsyncMock): await self.app.deliver(delivery)
        self.assertEqual(len(self.publications()), 1)


if __name__ == '__main__':
    unittest.main()
