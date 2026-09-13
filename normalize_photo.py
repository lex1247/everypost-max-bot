"""Decode MAX WebP photos into JPEG before cross-platform delivery."""
from io import BytesIO
from PIL import Image,ImageOps,UnidentifiedImageError

def normalize_webp(data):
    if not (data[:4]==b'RIFF' and data[8:12]==b'WEBP'):
        raise ValueError('Файл не является фотографией WebP.')
    try:
        with Image.open(BytesIO(data)) as src:
            if src.format!='WEBP' or getattr(src,'n_frames',1)!=1:
                raise ValueError('Анимированное изображение требует отдельной обработки.')
            if src.width*src.height>25_000_000:
                raise ValueError('Изображение слишком большое для обработки.')
            src.load();im=ImageOps.exif_transpose(src).convert('RGBA')
            canvas=Image.new('RGB',im.size,'white');canvas.paste(im,mask=im.getchannel('A'))
            out=BytesIO();canvas.save(out,format='JPEG',quality=95)
            encoded=out.getvalue()
            if len(encoded)>10_000_000:raise ValueError('Фотография после преобразования превышает 10 МБ.')
            return ('photo.jpg',encoded,'image/jpeg')
    except (UnidentifiedImageError,OSError,Image.DecompressionBombError) as exc:
        raise ValueError('Фотографию WebP не удалось прочитать. Материал сохранён для проверки.') from exc
