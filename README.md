# QRIS Generator

Generator kode **QRIS dinamis** (berganti nominal) dari gambar QRIS statis.
Berjalan **100% di browser — tanpa server/API**: bisa dibuka sebagai berkas
statis biasa. Tidak ada gambar atau data QRIS yang dikirim ke mana pun.

## Format gambar yang didukung

| Format | Cara dibaca |
|---|---|
| PNG, JPG/JPEG, WebP, BMP, GIF, SVG | langsung oleh browser |
| **HEIC / HEIF** (foto bawaan iPhone) | dekoder lokal `vendor/libheif-bundle.js` (WebAssembly, dimuat hanya saat diperlukan) |
| AVIF | dukungan bawaan browser (Chrome/Firefox/Safari versi baru) |

Kalau formatnya tidak bisa dibaca, halaman ini **menyebutkan formatnya** dan
memberi saran konkret (mis. "ubah dulu ke JPG"), bukan pesan umum seperti
"file gambar tidak bisa dibuka".

## Berkas yang "hampir benar" diperbaiki otomatis

Ukuran/rasio gambar tidak pernah jadi syarat: selama ada kode QRIS di dalam
gambar, formatnya bebas. Yang sering bikin gagal justru **isi berkasnya yang
tidak utuh**, dan sekarang itu ditambal sendiri sebelum menyerah:

| Kondisi berkas | Yang dilakukan |
|---|---|
| JPEG terpotong (unduhan/salinan belum selesai, penanda akhir `FFD9` hilang) | sisa gambar ditambal lalu ditutup penanda akhir, beberapa ukuran dicoba berurutan |
| Ada sampah di depan (header HTTP, teks terbawa) | dipotong sampai tanda tangan format (PNG/JPEG/GIF/BMP/HEIF) |
| Ada sampah di belakang (berkas tersambung) | dipotong di `FFD9` (JPEG) atau `IEND` (PNG) |
| Isinya teks `data:image/...;base64,...` atau base64 polos | didekode dulu jadi biner |

Kalau perbaikan berhasil, halaman tetap memproses gambarnya dan menyebutkan
apa yang diperbaiki di bawah pratinjau.

## Gagal **membaca** berkas ≠ gagal **membaca gambar**

Pesan `The requested file could not be read, typically due to permission
problems…` (`NotReadableError`) bukan soal format atau ukuran gambar: berkasnya
sudah berubah/kedaluwarsa sejak dipilih — paling sering saat memilih langsung
dari Google Photos/Drive/iCloud. Halaman ini membedakannya dari kegagalan
dekode, mencoba jalur baca cadangan (`FileReader`), dan kalau tetap gagal
menyarankan yang benar: **pilih ulang berkasnya**, atau simpan dulu ke
penyimpanan HP lalu unggah dari Galeri/Files.

## Cara kerja

1. Berkas/URL gambar diperiksa dulu **magic bytes**-nya, jadi formatnya
   dikenali walau ekstensi berkasnya salah atau tidak ada
   (contoh: foto iPhone `.HEIC`, atau JPEG yang dinamai `.jfif`).
   Kalau isinya tidak utuh (terpotong/ada sampah/base64), byte-nya
   dibersihkan & ditambal dulu (`BYTES`), lalu dicoba didekode lagi.
2. Gambar dimuat: dicoba jalur bawaan browser (`createImageBitmap` → `<img>`),
   lalu — untuk HEIC/HEIF — dekoder WebAssembly lokal. PNG berlatar
   transparan diratakan ke latar putih lebih dulu.
3. Kode QR dipindai dengan [jsQR](vendor/jsqr.min.js) memakai beberapa kandidat
   berurutan: resolusi ringan → resolusi penuh → perbesaran (QR kecil) →
   petak 2×2/3×3 (QR kecil di sudut foto besar) → versi hitam-putih (Otsu).
4. Payload EMV MPM hasil pindai diubah:
   - tag `01` (Point of Initiation) menjadi `12` (dinamis),
   - tag `54` (Transaction Amount) disisipkan/diganti dengan nominal,
   - tag `55` (tip) dibuang karena nominalnya sudah pasti,
   - tag `63` (CRC16/CCITT, poly `0x1021`, init `0xFFFF`) dihitung ulang atas
     **byte UTF-8** payload — nama merchant non-ASCII tetap valid.
5. QR baru digambar ulang dengan [qrcode-generator](vendor/qrcode.min.js)
   (+ dukungan UTF-8, koreksi kesalahan `H` bila tema punya logo tengah), lalu
   **ditempel ke kartu bergambar Tiyanstore · Rimuru** (tema bawaan, tanpa
   pemilih di halaman) dengan **logo di tengah QR**. Di bawah QR ditulis
   berurutan: nominal, nama toko, lalu kota/kabupaten (tag `59`/`60`).
   String QRIS-nya juga disediakan untuk disalin.

   Presisi tempel: modul QR digambar dengan batas piksel bulat (tanpa celah/
   overlap/anti-alias abu-abu), dan tema bisa mendeklarasikan `qr.cover` — persegi yang
   ditutup putih penuh mengikuti tepi kotak putih artwork persis, sehingga
   contoh QR cetakan pada background tertutup rata tanpa sisa (gompel/bolong)
   dan frame artwork di luarnya tidak ikut tertimpa.

## Menjalankan

Buka `index.html` langsung di browser, atau:

```bash
python3 -m http.server 8000
# buka http://localhost:8000
```

`contoh-qris-statis.png` adalah gambar contoh dengan data merchant fiktif
untuk uji coba.

## Kalau gambar gagal dibaca

1. Perhatikan catatan di bawah area unggah — di sana tertulis format yang
   terdeteksi, alasannya, dan (bila ada) perbaikan otomatis yang dilakukan.
2. Cara paling aman: **tangkapan layar (screenshot)** halaman QRIS dari
   aplikasi bank/e-wallet, lalu unggah hasilnya (PNG/JPG).
3. Untuk HEIC: buka di Safari (iPhone/Mac) atau ekspor ulang dari aplikasi
   Foto sebagai JPG. Untuk AVIF di browser lama: ubah ke JPG/PNG.

## Tema kartu

Hasil generate **selalu** berupa kartu bergambar Tiyanstore · Rimuru
(pemilih tema dan opsi unggah background sendiri tidak ditampilkan di
halaman): QR dinamis ditempel ke background, lalu di bawah QR tertulis
berurutan **nominal → nama toko → kota/kabupaten**. QR di kiri **dengan
logo Rimuru di tengahnya** (koreksi kesalahan `H`).

Semua digambar **di browser** (`THEME.compose` di `src/qris-core.js`): background + QR dinamis + teks nominal, nama toko (tag `59`), dan kota/kabupaten (tag `60`). Tidak ada unggahan ke server.

`THEME.stackText()` merapikan ketiga baris itu sebelum digambar — baris yang
saling menimpa didorong turun, dan seluruh blok digeser bila melewati dasar
kanvas. Jadi posisi di `themes.json` tetap jadi acuan, tapi teks tidak akan
pernah bertabrakan walaupun nominalnya panjang.

Folder tema: `assets/themes/` (`themes.json` + gambar). Tambah tema baru dengan menaruh gambar + entri layout (`qr.x/y/size`, `nominal.x/y/...`, `merchant.name/city`) di `themes.json`.

## Struktur

```
index.html             halaman + alur UI (muat gambar, pindai, tampilkan hasil)
src/qris-core.js       logika inti tanpa DOM: PROBE, BYTES, IMG, SCAN, EMV, RENDER, THEME
assets/themes/         tema kartu Tiyanstore · Rimuru + themes.json
assets/img/            logo & ikon web (favicon, logo, banner share/og-image, manifest)
vendor/                library lokal: jsQR, qrcode-generator, libheif (wasm)
test/                  pengujian Node + fixture gambar (PNG/JPG/HEIC/AVIF)
```

## SEO & logo web

Branding pencarian & share memakai nama **Qgen** (nama tampil di judul halaman,
`<h1>`, meta description, dan JSON-LD `WebApplication` + `WebSite`), supaya
pencarian "Qgen"/"qgen" di Google dikenali sebagai aplikasi ini.

Semua gambar pendukung disimpan **lokal di `assets/img/`** — tidak memakai CDN,
jadi logo/banner tetap tampil walaupun tautan lama (mis. gambar di penyimpanan
eksternal) sudah kedaluwarsa:

| Berkas | Fungsi |
|---|---|
| `qgen-logo.png` | logo asli (master, 1254×1254) |
| `logo.png` / `logo-192.png` | logo 512/192 px (manifest & header) |
| `logo-maskable-512.png` | ikon maskable (Android/PWA) |
| `favicon-32x32.png`, `favicon-16x16.png` | ikon tab browser |
| `apple-touch-icon.png` | ikon bookmark/layar utama iOS |
| `og-image.jpg` | banner 1200×630 saat link dibagikan (WhatsApp/Facebook/X) |
| `site.webmanifest` | metadata PWA (nama, warna, ikon) |

Tag di `<head>`: description + keywords, canonical, robots, Open Graph, Twitter
Card, ikon, manifest, theme-color, dan JSON-LD (`<script type="application/ld+json">`).
Selain itu ada blok `<noscript>` berisi penjelasan aplikasi untuk mesin pencari
dan browser tanpa JavaScript.

Agar cepat terindeks Google: daftarkan URL situs di
[Google Search Console](https://search.google.com/search-console) lalu minta
pengindeksan. Kalau domain produksi berubah (bukan
`https://qris-generator-three.vercel.app/`), perbarui URL di tag `canonical`,
`og:url`, `og:image`, `twitter:image`, dan blok JSON-LD.

## Uji

```bash
npm install
npm test
```

Pengujian mencakup logika EMV/CRC, pengenalan format, penyelamatan berkas rusak
(JPEG terpotong/sampah di depan-belakang/base64), pengolahan citra, tema kartu
(QR + nominal di background), dan alur nyata (PNG/JPG terkompresi/HEIC/QR
kecil/QR terbalik/latar transparan/foto besar) sampai hasil generate dipindai
ulang. Fixture gambar dibuat ulang dengan `python3 test/make-fixtures.py`
(butuh Pillow + pillow-heif).
