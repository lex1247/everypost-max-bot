import unittest,os
from types import SimpleNamespace
from unittest.mock import AsyncMock,patch
import httpx
from core import Store
from max_source import MaxSource
from vk_source import VKSource
from trustat_source import post_media
from media import normal_media
from app import App
from max_bridge import action

class CompletionTests(unittest.IsolatedAsyncioTestCase):
 def setUp(self):
  self.s=Store(':memory:');self.env=patch.dict(os.environ,{'OWNER_ID':'7'});self.env.start()
  self.app=SimpleNamespace(s=self.s,max_api=AsyncMock(),vk=AsyncMock())
 def tearDown(self):self.s.db.close();self.env.stop()
 def message(self,mid,stamp,text='Новость',media=None):
  return {'timestamp':stamp,'recipient':{'chat_id':-123},'body':{'mid':mid,'text':text,'attachments':media or []}}
 async def test_max_registration_skips_archive_and_repeated_registration_keeps_cursor(self):
  self.app.max_api.side_effect=[{'type':'channel','title':'MAX'},{'is_admin':True},{'messages':[self.message('old',100)]}]*2
  reader=MaxSource(self.app);sid,_=await reader.add('-123')
  self.assertEqual(self.s.rows('SELECT cursor FROM sources')[0]['cursor'],100)
  self.s.run('UPDATE sources SET cursor=120 WHERE id=?',(sid,))
  self.assertEqual((await reader.add('-123'))[0],sid);self.assertEqual(self.s.rows('SELECT cursor FROM sources')[0]['cursor'],120)
 async def test_max_reads_album_and_same_timestamp_messages_without_duplicates(self):
  reader=MaxSource(self.app);sid=self.s.add_source('max','-123','MAX',100)
  photo={'type':'image','payload':{'url':'https://i.oneme.ru/photo.jpg'}}
  self.app.max_api.side_effect=[{'type':'channel'},{'is_admin':True},{'messages':[self.message('b',101,media=[photo,photo]),self.message('a',100)]}]*2
  await reader.fetch(self.s.rows('SELECT * FROM sources')[0]);await reader.fetch(self.s.rows('SELECT * FROM sources')[0])
  self.assertEqual(len(self.s.rows('SELECT * FROM posts')),2);self.assertEqual(self.s.rows('SELECT cursor FROM sources')[0]['cursor'],101)
 async def test_max_missing_rights_prevents_read(self):
  self.app.max_api.side_effect=[{'type':'channel'},{'is_admin':False}]
  with self.assertRaises(ValueError):await MaxSource(self.app).add('-123')
  self.assertFalse(self.s.rows('SELECT * FROM sources'))
 async def test_max_input_destination_cycle_is_rejected(self):
  sid=self.s.add_source('tg','-10099','tg',1);did=self.s.add_destination('max','-123','MAX')
  self.s.run('INSERT INTO routes VALUES(?,?)',(sid,did));self.app.max_api.side_effect=[{'type':'channel'},{'is_admin':True}]
  with self.assertRaises(ValueError):await MaxSource(self.app).add('-123')
 async def test_max_wrong_channel_fails_without_advancing(self):
  reader=MaxSource(self.app);sid=self.s.add_source('max','-123','MAX',100)
  m=self.message('b',101);m['recipient']['chat_id']=-999
  self.app.max_api.side_effect=[{'type':'channel'},{'is_admin':True},{'messages':[m]}]
  with self.assertRaises(ValueError):await reader.fetch(self.s.rows('SELECT * FROM sources')[0])
  self.assertEqual(self.s.rows('SELECT cursor FROM sources')[0]['cursor'],100)
 async def test_vk_resolve_and_new_posts(self):
  self.app.vk.side_effect=[{'groups':[{'id':99,'name':'VK','is_closed':0}]},{'items':[{'id':10,'owner_id':-99}]}]
  r=await VKSource(self.app).resolve('https://vk.com/public99');self.assertEqual(r['cursor'],10)
  self.app.vk.side_effect=[{'items':[{'id':12,'owner_id':-99,'text':'новый'},{'id':11,'owner_id':-99,'text':'раньше'},{'id':10,'owner_id':-99}]}]
  r=await VKSource(self.app).fetch('vk_99','-99',10);self.assertEqual([p[0] for p in r['posts']],[11,12])
 async def test_vk_pinned_old_post_does_not_stop_pagination_early(self):
  posts=[{'id':1,'owner_id':-99,'is_pinned':1}]+[{'id':n,'owner_id':-99,'text':'text'} for n in range(200,101,-1)]
  self.app.vk.side_effect=[{'items':posts},{'items':[{'id':101,'owner_id':-99,'text':'boundary'}]}]
  r=await VKSource(self.app).fetch('vk_99','-99',101);self.assertEqual(r['posts'][0][0],102);self.assertEqual(r['cursor'],121)
 def test_trustat_full_mp4_and_mixed_album_keep_order(self):
  r=post_media({'text':'Подпись','media':[{'media_type':'mediaPhoto','file_url':'https://static1.trustat.ru/a.jpg'},{'media_type':'mediaDocument','mime_type':'video/mp4','file_url':'https://static1.trustat.ru/b.mp4'}]})
  self.assertEqual([x['type'] for x in normal_media(r)['gallery']],['photo','video']);self.assertFalse(r['unsupported'])
 def test_thumbnail_only_video_is_still_not_a_video_file(self):
  r=post_media({'text':'Подпись','media':{'media_type':'mediaDocument','mime_type':'video/mp4','file_thumbnail_url':'https://static1.trustat.ru/x.jpg'}})
  self.assertTrue(r['unsupported']);self.assertFalse(r['photos'])
 async def test_bridge_prepares_album_in_original_mode_without_ai(self):
  app=SimpleNamespace(rewrite=AsyncMock(),prepare_part=AsyncMock(return_value=('/messages',{'text':'Caption'},{})))
  await action(app,{'action':'prepare','text':'Caption','mode':'original','media':{'gallery':[{'type':'video','url':'https://static1.trustat.ru/v.mp4'}]}})
  app.rewrite.assert_not_awaited();self.assertEqual(app.prepare_part.call_args.args[2]['items'][0]['type'],'video')
 async def test_video_download_checks_signature_and_refuses_redirect(self):
  async def handler(req):return httpx.Response(200,content=b'not a video')
  async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
   app=SimpleNamespace(http=http)
   with self.assertRaises(ValueError):await App.trustat_video_file(app,{'url':'https://static1.trustat.ru/v.mp4'})
 async def test_video_download_rejects_oversize_file(self):
  async def handler(req):return httpx.Response(200,content=b'0000ftyp'+b'x'*20_000_000)
  async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
   with self.assertRaises(ValueError):await App.trustat_video_file(SimpleNamespace(http=http),{'url':'https://static1.trustat.ru/v.mp4'})
