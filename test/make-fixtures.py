#!/usr/bin/env python3
"""Buat ulang gambar uji di test/fixtures dari contoh-qris-statis.png.

Butuh: pip install Pillow pillow-heif
Jalankan: python3 test/make-fixtures.py
"""
import random
from pathlib import Path

from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

register_heif_opener()

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / 'test' / 'fixtures'
FIX.mkdir(parents=True, exist_ok=True)

src_rgba = Image.open(ROOT / 'contoh-qris-statis.png').convert('RGBA')
src = src_rgba.convert('RGB')

# HEIC (format bawaan kamera iPhone) — penyebab utama "file gambar tidak bisa dibuka"
src.save(FIX / 'qris.heic', format='HEIF', quality=80)

# AVIF (ISO-BMFF juga, ditangani dekoder yang sama)
src.save(FIX / 'qris.avif', format='AVIF', quality=60)

# JPEG dengan kompresi berat (mirip gambar yang dikirim ulang lewat chat)
src.save(FIX / 'qris-jpeg-berat.jpg', quality=30)

# QR kecil — butuh jalur "perbesar" saat dipindai
src.resize((240, 240), Image.LANCZOS).save(FIX / 'qris-kecil.png')

# QR berlatar transparan — butuh flatten ke latar putih
transparan = src_rgba.copy()
pixels = transparan.load()
for y in range(transparan.height):
    for x in range(transparan.width):
        r, g, b, a = pixels[x, y]
        if r > 200 and g > 200 and b > 200:
            pixels[x, y] = (r, g, b, 0)
transparan.save(FIX / 'qris-transparan.png')

# QR terbalik (terang di atas gelap) — uji mode inversion
ImageOps.invert(src).save(FIX / 'qris-terbalik.png')

# "Foto": QR kecil di salah satu sudut kanvas besar + sedikit noise
random.seed(7)
foto = Image.new('RGB', (1600, 1200), (238, 237, 232))
foto.paste(src.resize((460, 460), Image.LANCZOS), (980, 430))
noise = Image.effect_noise((1600, 1200), 8).convert('L')
foto = Image.composite(Image.new('RGB', foto.size, (255, 255, 255)), foto, noise.point(lambda v: 255 if v > 235 else 0))
foto.save(FIX / 'foto-qris.jpg', quality=80)

print('Fixture dibuat di', FIX)
for path in sorted(FIX.iterdir()):
    print(f'  {path.name:24s} {path.stat().st_size / 1024:7.1f} KB')
