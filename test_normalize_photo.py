import unittest
from io import BytesIO
from PIL import Image
from normalize_photo import normalize_webp
class WebPTests(unittest.TestCase):
 def webp(self,animated=False):
  out=BytesIO();im=Image.new('RGBA',(12,8),(20,30,40,128))
  im.save(out,format='WEBP',lossless=True,save_all=animated,append_images=[Image.new('RGBA',(12,8),'red')] if animated else [])
  return out.getvalue()
 def test_webp_to_jpeg_keeps_dimensions(self):
  name,data,mime=normalize_webp(self.webp());self.assertEqual(mime,'image/jpeg');self.assertEqual(name,'photo.jpg')
  with Image.open(BytesIO(data)) as im:self.assertEqual(im.size,(12,8));self.assertEqual(im.mode,'RGB')
 def test_animation_not_silently_flattened(self):
  with self.assertRaises(ValueError):normalize_webp(self.webp(True))
 def test_invalid_or_truncated_image_rejected(self):
  for data in (b'bad',b'RIFF1234WEBPbroken',self.webp()[:20]):
   with self.assertRaises(ValueError):normalize_webp(data)
