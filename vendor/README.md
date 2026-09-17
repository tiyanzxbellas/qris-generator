# Vendor libraries (lokal, tanpa CDN)

| File | Paket | Versi | Lisensi |
|---|---|---|---|
| `jsqr.min.js` | [jsQR](https://github.com/cozmo/jsQR) | 1.4.0 | Apache-2.0 (`jsQR.LICENSE`) |
| `qrcode.min.js` | [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) | 1.4.4 | MIT (header di dalam file) |
| `qrcode-utf8.js` | add-on UTF-8 qrcode-generator | 1.4.4 | MIT (header di dalam file) |
| `libheif-bundle.js` | [libheif-js](https://github.com/catdad-experiments/libheif-js) | 1.19.8 | LGPL-3.0 (`libheif.LICENSE`) |

File-file ini dipakai untuk memindai dan menggambar ulang QR sepenuhnya di
browser, tanpa API eksternal.

## Catatan `libheif-bundle.js`

- Dipakai **hanya** kalau gambar berformat HEIC/HEIF (mis. foto bawaan iPhone)
  dan browser tidak bisa membukanya sendiri. Berkas ini 1,4 MB karena berisi
  WebAssembly libheif (tertanam base64), jadi bisa jalan tanpa jaringan —
  termasuk saat `index.html` dibuka langsung dari `file://`.
- Yang tertanam: dekoder **HEVC/HEIC**. Build ini **tanpa** dekoder AV1,
  sehingga AVIF tetap bergantung pada dukungan bawaan browser; halaman akan
  memberi tahu pengguna bila formatnya tidak bisa dibuka.
- Sidik jari berkas: `md5 597cb21e0bc745387c5bab362808d3e9`
  (`npm pack libheif-js@1.19.8` → `package/libheif-wasm/libheif-bundle.js`).
- Lisensi LGPL-3.0 disertakan apa adanya di `libheif.LICENSE`.
