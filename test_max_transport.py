import os
import ssl
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from app import App
from core import Store
from max_transport import max_ssl_context


class MaxTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_certificate_verification_remains_enabled(self):
        context = max_ssl_context()
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)

    async def test_max_credentials_only_reach_dedicated_client(self):
        store = Store(':memory:')
        try:
            general, maximum = AsyncMock(), AsyncMock()
            maximum.request.return_value = httpx.Response(200, json={'user_id': 7})
            with patch.dict(os.environ, {'OWNER_ID': '1', 'MAX_BOT_TOKEN': 'max-test-token',
                                        'MAX_API_BASE': 'https://platform-api2.max.ru'}):
                app = App(store, general, max_client=maximum)
                self.assertEqual(await app.max_api('GET', '/me'), {'user_id': 7})
            maximum.request.assert_awaited_once_with('GET', 'https://platform-api2.max.ru/me',
                                                     headers={'Authorization': 'max-test-token'})
            general.request.assert_not_awaited()
        finally:
            store.db.close()
