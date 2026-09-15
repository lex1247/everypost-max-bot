import asyncio
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
spec = importlib.util.spec_from_file_location('content_source', Path(__file__).with_name('content_source.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class ContentTests(unittest.IsolatedAsyncioTestCase):
    def test_sources(self):
        self.assertEqual(m.source_url('@miaoloo'), 'https://www.tiktok.com/@miaoloo')
        for u in ['http://tiktok.com/@x','https://localhost/@x','https://www.tiktok.com.evil/@x','https://www.tiktok.com:444/@x','https://www.tiktok.com/redirect']:
            with self.assertRaises(ValueError): m.source_url(u)

    def test_metadata(self):
        i=m.normalize({'id':'7221888273554181419','uploader_id':'miaoloo','view_count':0,'like_count':None,'timestamp':0,'duration':12}, 'https://www.tiktok.com/@miaoloo')
        self.assertEqual(i['metrics']['views'],0)
        self.assertIsNone(i['metrics']['likes'])
        self.assertEqual(i['published_at'],'1970-01-01T00:00:00+00:00')
        self.assertIn('/video/7221888273554181419',i['canonical_url'])
        real=m.normalize({'id':'7221888273554181419','uploader_id':'6959803543580034054','uploader_url':'https://www.tiktok.com/@miaoloo','uploader':'miaoloo'},'https://www.tiktok.com/@miaoloo')
        self.assertEqual(real['author'],'miaoloo')

    async def test_download_rejects_arbitrary_hosts(self):
        for u in ['https://127.0.0.1/video','https://tiktokcdn.com.evil/video','file:///etc/passwd']:
            with self.assertRaises(ValueError): await m.download(u)

    async def test_account_batch(self):
        entries=[{'id':str(7221888273554181419+i),'uploader_id':'miaoloo'} for i in range(40)]
        with patch.object(m,'extract',AsyncMock(return_value={'_type':'playlist','entries':entries})):
            data=await m.fetch('@miaoloo')
            self.assertEqual(len(data['items']),30)

    async def test_empty_is_error(self):
        with patch.object(m,'extract',AsyncMock(return_value={'_type':'playlist','entries':[]})):
            with self.assertRaises(ValueError): await m.fetch('@miaoloo')

    async def test_wrong_video_never_uploads(self):
        app=type('App',(),{'max_api':AsyncMock()})()
        with patch.object(m,'extract',AsyncMock(return_value={'id':'7221888273554181418'})):
            with self.assertRaises(ValueError): await m.prepare(app,'https://www.tiktok.com/@miaoloo/video/7221888273554181419')
        app.max_api.assert_not_called()

    async def test_preparation_uploads_only_and_hashes_bytes(self):
        import hashlib
        data=b'\x00\x00\x00\x18ftypmp42sample-video'
        class Stream:
            status_code=200
            async def __aenter__(self): return self
            async def __aexit__(self,*args): pass
            async def aiter_bytes(self): yield data
        class HTTP:
            def stream(self,*args,**kwargs): return Stream()
            post=AsyncMock(return_value=type('Response',(),{'is_error':False,'is_redirect':False})())
        app=type('App',(),{'http':HTTP(),'max_http':None,'max_api':AsyncMock(return_value={'url':'https://omub.okcdn.ru/upload','token':'test-video'})})()
        info={'id':'7221888273554181419','formats':[{'ext':'mp4','vcodec':'h264','acodec':'aac','protocol':'https','url':'https://a.tiktokcdn.com/v','height':720}]}
        with patch.object(m,'extract',AsyncMock(return_value=info)), patch.object(m,'download',AsyncMock(return_value=data)):
            result=await m.prepare(app,'https://www.tiktok.com/@miaoloo/video/7221888273554181419')
        self.assertEqual(result['content_hash'],hashlib.sha256(data).hexdigest())
        self.assertEqual(result['body']['text'],'')
        app.max_api.assert_awaited_once_with('POST','/uploads',params={'type':'video'})

if __name__=='__main__': unittest.main()
