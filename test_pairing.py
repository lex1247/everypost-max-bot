import copy
import unittest
from setup_owner import pairing_owner


class PairingTests(unittest.TestCase):
    def setUp(self):
        self.update = {'message': {'from': {'id': 123, 'is_bot': False},
                                  'chat': {'id': 123, 'type': 'private'},
                                  'text': '/start bind_test'}}

    def test_exact_challenge_in_private_chat(self):
        self.assertEqual(pairing_owner(self.update, 'bind_test'), 123)

    def test_unrelated_and_partial_messages_do_not_claim_owner(self):
        for text in ('/start', '/start bind_other', '/start bind_test trailing', 'привет'):
            self.update['message']['text'] = text
            self.assertIsNone(pairing_owner(self.update, 'bind_test'))

    def test_groups_bots_and_mismatched_chat_cannot_claim(self):
        for field, changed in [('chat', {'id': 123, 'type': 'group'}),
                               ('chat', {'id': 456, 'type': 'private'}),
                               ('from', {'id': 123, 'is_bot': True})]:
            update = copy.deepcopy(self.update)
            update['message'][field] = changed
            self.assertIsNone(pairing_owner(update, 'bind_test'))

    def test_missing_message_does_not_claim(self):
        self.assertIsNone(pairing_owner({}, 'bind_test'))
