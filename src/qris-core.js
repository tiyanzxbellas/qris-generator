/*!
 * qris-core.js — logika inti QRIS Generator (tanpa DOM, bisa diuji di Node)
 *
 * Bagian:
 *   PROBE  : mengenali format berkas dari magic bytes (PNG/JPG/HEIC/TIFF/PDF/…)
 *   BYTES  : menyelamatkan isi berkas sebelum didekode (buang sampah di depan/
 *            belakang, data URL/base64, JPEG-PNG yang terpotong)
 *   IMG    : operasi citra di atas ImageData (flatten, grayscale, Otsu, crop,
 *            scale, tile) — dipakai untuk menyiapkan kandidat pemindaian
 *   SCAN   : strategi pemindaian QR bertingkat (multi resolusi + petak + ambang)
 *   EMV    : payload QRIS (TLV EMV MPM + CRC16/CCITT)
 *   RENDER : menyusun ulang QR (matriks modul → PNG di browser)
 *
 * Ketergantungan (diambil dari global saat dipanggil, jadi bisa disuntik
 * dari Node untuk pengujian): `jsQR` (vendor/jsqr.min.js) dan `qrcode`
 * (vendor/qrcode.min.js).
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QRISCORE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  function libJsQR() {
    const fn = root && root.jsQR;
    if (typeof fn !== 'function') throw new Error('Library pemindai QR (jsQR) belum termuat');
    return fn;
  }
  function libQrcode() {
    const fn = root && root.qrcode;
    if (typeof fn !== 'function') throw new Error('Library pembuat QR (qrcode-generator) belum termuat');
    return fn;
  }

  /* Path persegi membulat (dipakai drawMatrix, slot QR, dan logo tengah) */
  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, r);
    } else {
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
  }

  /* ==================================================================== */
  /* PROBE — identifikasi format dari magic bytes                          */
  /* ==================================================================== */

  const PROBE = {
    /* jumlah byte awal yang perlu dibaca untuk mengenali format */
    HEAD_BYTES: 64,

    /*
      Baca N byte pertama dari Blob/File.
      Di HP Android/iOS, blob.slice() + arrayBuffer() sering gagal dengan
      NotReadableError ketika file-nya datang dari content:// URI
      (Google Photos/Drive/iCloud). Jadi:
        1) Utamakan FileReader di SELURUH blob (tanpa slice) — paling reliable
           di mobile — lalu potong head-nya dari buffer yang sudah di tangan.
        2) Fallback: slice + arrayBuffer (cara ringkas, gagal di beberapa HP).
        3) Fallback: slice + FileReader.
    */
    async readHead(blob, n) {
      n = n || this.HEAD_BYTES;
      if (!blob) throw new Error('Berkas tidak tersedia');

      /* Coba 1: FileReader di SELURUH file (paling stabil di mobile).
         Untuk file kecil (< 8 MB) biayanya sebanding; untuk file besar
         hanya membaca header pun butuh akses ke content provider yang sama,
         jadi reliabilitasnya lebih penting daripada sedikit memori. */
      try {
        const full = await this.readWithFileReader(blob);
        if (full.length <= n) return full;
        return full.subarray(0, n);
      } catch (allErr) {
        /* lanjut ke cara slice */
      }

      /* Coba 2: slice + FileReader */
      const part = (typeof blob.slice === 'function') ? blob.slice(0, n) : blob;
      try {
        return await this.readWithFileReader(part);
      } catch (frErr) {
        /* lanjut ke arrayBuffer */
      }

      /* Coba 3: slice + arrayBuffer (browser modern) */
      if (typeof part.arrayBuffer === 'function') {
        try {
          return new Uint8Array(await part.arrayBuffer());
        } catch (abErr) {
          /* lempar error dari FileReader (lebih ramah mobile) */
          throw abErr && abErr.message ? abErr : (frErr || new Error('Berkas tidak bisa dibaca'));
        }
      }

      throw frErr || new Error('Berkas tidak bisa dibaca');
    },

    readWithFileReader(part) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(new Uint8Array(fr.result));
        fr.onerror = () => reject(fr.error || new Error('Berkas tidak bisa dibaca'));
        fr.readAsArrayBuffer(part);
      });
    },

    /*
      Hasil sniff:
        { family, mime, label, decoder, note }
        family: 'empty' | 'not-image' | 'other' | 'heif' | 'native' | 'unknown'
          empty      = berkas 0 byte
          not-image  = jelas bukan gambar (PDF, ZIP, dsb.)
          other      = gambar, tapi browser umumnya tak bisa membukanya
          heif       = berkas ISO-BMFF (HEIC/HEIF/AVIF)
          native     = umumnya langsung bisa dibuka browser
          unknown    = tidak dikenali
        decoder: 'libheif' bila dekoder lokal (vendor/libheif-bundle.js) bisa
          menangani format ini — saat ini HEIC/HEIF (HEVC). AVIF hanya bisa
          lewat dukungan bawaan browser karena build wasm tanpa dekoder AV1.
    */
    sniff(bytes) {
      const b = bytes || [];
      const n = b.length;
      const ascii = (from, len) => {
        let s = '';
        for (let i = from; i < Math.min(from + len, n); i++) s += String.fromCharCode(b[i]);
        return s;
      };
      const fourCC = (off, txt) => ascii(off, txt.length) === txt;
      const native = (mime, label) => ({ family: 'native', mime, label, decoder: '', note: '' });
      const other = (mime, label, note) => ({ family: 'other', mime, label, decoder: '', note: note || '' });
      const heif = (mime, label, decoder) => ({ family: 'heif', mime, label, decoder: decoder || '', note: '' });

      if (!n) return { family: 'empty', mime: '', label: 'berkas kosong', decoder: '', note: '' };

      /* --- format gambar yang umum didukung browser --- */
      if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return native('image/png', 'PNG');
      if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return native('image/jpeg', 'JPEG');
      if (fourCC(0, 'GIF8')) return native('image/gif', 'GIF');
      if (fourCC(0, 'RIFF') && fourCC(8, 'WEBP')) return native('image/webp', 'WebP');
      if (b[0] === 0x42 && b[1] === 0x4d) return native('image/bmp', 'BMP');
      if (b[0] === 0x00 && b[1] === 0x00 && (b[2] === 0x01 || b[2] === 0x02) && b[3] === 0x00) {
        return native('image/x-icon', 'ICO');
      }

      /* --- teks: SVG --- */
      const head = ascii(0, 400).trim().toLowerCase();
      if (head.startsWith('<svg') ||
          ((head.startsWith('<?xml') || head.startsWith('<!doctype')) && head.indexOf('<svg') >= 0)) {
        return native('image/svg+xml', 'SVG');
      }

      /* --- gambar/heiF berbasis ISO-BMFF (kotak 'ftyp') --- */
      if (fourCC(4, 'ftyp')) {
        const brand = ascii(8, 4).toLowerCase();
        const compat = ascii(16, Math.min(48, Math.max(0, n - 16))).toLowerCase();
        const all = brand + compat;
        /* AVIF di dalam ISO-BMFF: build wasm libheif tanpa dekoder AV1, jadi
           hanya bisa lewat dukungan bawaan browser */
        if (all.indexOf('avif') >= 0 || all.indexOf('avis') >= 0) return heif('image/avif', 'AVIF', '');
        if (all.indexOf('heic') >= 0 || all.indexOf('heix') >= 0 || all.indexOf('hevc') >= 0 ||
            all.indexOf('hevx') >= 0 || all.indexOf('heim') >= 0 || all.indexOf('heis') >= 0 ||
            all.indexOf('hevm') >= 0 || all.indexOf('hevs') >= 0) return heif('image/heic', 'HEIC', 'libheif');
        if (all.indexOf('mif1') >= 0 || all.indexOf('msf1') >= 0 || all.indexOf('miaf') >= 0) {
          return heif('image/heif', 'HEIF', 'libheif');
        }
        return heif('image/heif', 'HEIF', 'libheif');
      }

      /* --- jelas bukan gambar --- */
      const notImage = (mime, label) => ({ family: 'not-image', mime, label, decoder: '', note: '' });
      if (fourCC(0, '%PDF')) return notImage('application/pdf', 'PDF');
      if (b[0] === 0x50 && b[1] === 0x4b) return notImage('application/zip', 'ZIP/Office');
      if (fourCC(0, '8BPS')) return notImage('image/vnd.adobe.photoshop', 'Photoshop (PSD)');
      if (b[0] === 0x25 && b[1] === 0x21) return notImage('application/postscript', 'PostScript');
      if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
        return notImage('video/webm', 'video (WebM/MKV)');
      }

      /* --- gambar tapi butuh dukungan khusus --- */
      if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
          (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)) {
        return other('image/tiff', 'TIFF/RAW', 'Hanya sebagian browser (Safari) bisa membuka TIFF.');
      }
      if (b[0] === 0xff && b[1] === 0x0a) return other('image/jxl', 'JPEG XL', '');
      if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x00 && b[3] === 0x0c && fourCC(4, 'JXL ')) {
        return other('image/jxl', 'JPEG XL', '');
      }
      if (b[0] === 0xff && b[1] === 0x4f) return other('image/jp2', 'JPEG 2000', '');
      if (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0xbc && b[3] === 0x01) {
        return other('image/jp2', 'JPEG 2000', '');
      }
      if (b[0] === 0x46 && b[1] === 0x4f && b[2] === 0x52 && b[3] === 0x4d) {
        return other('image/x-iff', 'IFF/ILBM', '');
      }

      return { family: 'unknown', mime: '', label: 'tidak dikenali', decoder: '', note: '' };
    },

    /* Pesan siap tampil untuk kombinasi { info, stage } */
    message(info, stage) {
      const label = (info && info.label) || 'tidak dikenali';
      switch (info && info.family) {
        case 'empty':
          return 'Berkas berukuran 0 KB (kosong atau gagal tersalin), jadi tidak ada gambar yang bisa dibaca. ' +
                 'Coba pilih ulang berkasnya atau unduh ulang gambarnya.';
        case 'not-image':
          return 'Berkas yang dipilih terdeteksi ' + label + ', bukan gambar QRIS. ' +
                 'Unggah berkas gambar (PNG/JPG/HEIC/WebP) yang berisi kode QRIS.';
        case 'other':
          return 'Gambar terdeteksi berformat ' + label + ', tetapi browser tidak bisa membukanya. ' +
                 'Ubah dulu ke PNG atau JPG, lalu unggah lagi.';
        case 'heif':
          if (!info.decoder) {
            return 'Browser ini belum bisa membuka gambar ' + label + ', dan dekoder cadangan ' +
                   'tidak mendukung format tersebut. Ubah dulu ke JPG atau PNG, lalu unggah lagi.';
          }
          if (stage === 'decode') {
            return 'Berkas ' + label + ' memang terdeteksi, tapi isinya gagal didekode. ' +
                   'Coba buka gambarnya di aplikasi Foto lalu simpan/ekspor ulang sebagai JPG, atau buka halaman ini di Safari.';
          }
          return 'Berkas ' + label + ' perlu dekoder tambahan yang belum bisa dijalankan di browser ini.';
        case 'native':
          return 'Berkas ' + label + ' ini isinya tidak utuh (kemungkinan terpotong saat diunduh/dikirim), ' +
                 'jadi gambarnya tidak bisa dibuka — perbaikan otomatis pun tidak berhasil. ' +
                 'Kirim/unduh ulang gambarnya, atau buka gambarnya lalu ambil tangkapan layar (screenshot) dan unggah hasilnya.';
        default:
          return 'Isi berkas tidak dikenali sebagai gambar (format tidak didukung). ' +
                 'Pastikan berkasnya benar-benar gambar QRIS: PNG, JPG, WebP, HEIC, atau AVIF.';
      }
    },

    /* Ringkasan singkat untuk ditampilkan di UI */
    describe(info) {
      if (!info) return '';
      if (info.family === 'unknown') return 'format tidak dikenali';
      return info.label;
    },
  };

  /* ==================================================================== */
  /* BYTES — menyelamatkan isi berkas sebelum didekode                     */
  /* ==================================================================== */

  /*
    Banyak gambar QRIS yang dikirim lewat chat/unduhan sebenarnya "hampir
    benar": ada sampah di depan/belakang, isinya teks base64/data URL, atau
    berkasnya terpotong (EOI JPEG hilang) karena salin/unduh belum tuntas.
    Browser menolak berkas seperti itu dengan pesan "gagal didekode", padahal
    kode QR-nya utuh. BYTES membersihkan/menambal byte-nya dulu supaya jalur
    dekode bawaan browser mau menerimanya.
  */
  const BYTES = {
    /* batas pencarian tanda tangan format di awal berkas */
    SEARCH_AHEAD: 65536,

    /* tanda tangan format yang bisa dicari di tengah berkas */
    SIGNATURES: [
      { label: 'PNG', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
      { label: 'JPEG', bytes: [0xff, 0xd8, 0xff] },
      { label: 'GIF', bytes: [0x47, 0x49, 0x46, 0x38] },
      { label: 'BMP', bytes: [0x42, 0x4d] },
    ],

    indexOfSeq(bytes, seq, from, until) {
      const last = Math.min(bytes.length - seq.length, until === undefined ? bytes.length : until);
      outer:
      for (let i = Math.max(0, from || 0); i <= last; i++) {
        for (let j = 0; j < seq.length; j++) {
          if (bytes[i + j] !== seq[j]) continue outer;
        }
        return i;
      }
      return -1;
    },

    lastIndexOfSeq(bytes, seq, from) {
      outer:
      for (let i = Math.min(bytes.length - seq.length, from === undefined ? bytes.length : from); i >= 0; i--) {
        for (let j = 0; j < seq.length; j++) {
          if (bytes[i + j] !== seq[j]) continue outer;
        }
        return i;
      }
      return -1;
    },

    /* Berkas berisi teks base64 / data URL (bukan biner) → byte aslinya */
    fromBase64Text(bytes) {
      const n = bytes.length;
      if (n < 32) return null;
      /* cepat: hanya periksa awal berkas, harus ASCII yang masuk akal */
      const probe = Math.min(n, 512);
      let text = '';
      for (let i = 0; i < probe; i++) {
        const c = bytes[i];
        if (c === 0 || c > 126 || (c < 32 && c !== 9 && c !== 10 && c !== 13)) return null;
        text += String.fromCharCode(c);
      }
      const head = text.replace(/^\uFEFF/, '').trimStart();
      const isDataUrl = /^data:image\/[a-z0-9.+-]+;base64,/i.test(head);
      if (!isDataUrl && !/^[A-Za-z0-9+/\s]+={0,2}$/.test(head)) return null;

      let all = '';
      for (let i = 0; i < n; i++) all += String.fromCharCode(bytes[i]);
      let b64 = all.replace(/^\uFEFF/, '').trim();
      if (isDataUrl) b64 = b64.slice(b64.indexOf(',') + 1);
      b64 = b64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length < 24) return null;
      b64 = b64.slice(0, b64.length - (b64.replace(/=+$/, '').length % 4 === 1 ? 1 : 0));

      try {
        let bin;
        if (typeof atob === 'function') bin = atob(b64.replace(/=+$/, '') + '==='.slice(0, (4 - (b64.replace(/=+$/, '').length % 4)) % 4));
        else if (typeof Buffer !== 'undefined') bin = Buffer.from(b64, 'base64').toString('binary');
        else return null;
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
        return out.length >= 16 ? out : null;
      } catch (e) {
        return null;
      }
    },

    /* Potong sampah sebelum tanda tangan format (mis. header HTTP/teks chat) */
    trimLeadingJunk(bytes) {
      for (let i = 0; i < this.SIGNATURES.length; i++) {
        const sig = this.SIGNATURES[i];
        const at = this.indexOfSeq(bytes, sig.bytes, 1, this.SEARCH_AHEAD);
        if (at > 0) return { bytes: bytes.subarray(at), action: 'sampah ' + at + ' byte di awal berkas dibuang' };
      }
      const ftyp = this.indexOfSeq(bytes, [0x66, 0x74, 0x79, 0x70], 5, this.SEARCH_AHEAD);
      if (ftyp > 4) {
        return { bytes: bytes.subarray(ftyp - 4), action: 'sampah ' + (ftyp - 4) + ' byte di awal berkas dibuang' };
      }
      return null;
    },

    isJpeg(bytes) { return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff; },

    /*
      JPEG: buang sampah setelah penanda akhir (FFD9). Berkas hasil salin yang
      "kepanjangan" (mis. disambung berkas lain) jadi bisa dibaca lagi.
    */
    repairJpeg(bytes) {
      if (!this.isJpeg(bytes)) return null;
      const eoi = this.lastIndexOfSeq(bytes, [0xff, 0xd9]);
      if (eoi < 0 || eoi + 2 === bytes.length) return null;
      return {
        bytes: bytes.subarray(0, eoi + 2),
        action: 'sampah ' + (bytes.length - eoi - 2) + ' byte setelah akhir JPEG dibuang',
      };
    },

    /*
      JPEG yang belum selesai tersalin: penanda akhir (FFD9) hilang dan baris
      terakhir gambar tidak lengkap. Dekoder menolak berkas seperti ini walau
      kode QR-nya (yang biasanya ada di bagian atas/tengah) sudah utuh.
      Tambalannya: isi sisa data dengan byte 0 lalu tutup dengan FFD9 — dekoder
      jadi punya cukup data untuk menyelesaikan seluruh MCU, sisanya abu-abu.
      Jumlah bantalan tidak bisa ditebak pasti, jadi disediakan beberapa ukuran
      untuk dicoba berurutan.
    */
    padJpegVariants(bytes) {
      if (!this.isJpeg(bytes)) return [];
      if (this.lastIndexOfSeq(bytes, [0xff, 0xd9]) >= 0) return [];
      let end = bytes.length;
      while (end > 2 && bytes[end - 1] === 0xff) end--;      /* penanda separuh */
      const base = bytes.subarray(0, end);
      const sizes = [1 << 16, 1 << 18, 1 << 20, 1 << 22];    /* 64 KB … 4 MB */
      return sizes.map(pad => {
        const out = new Uint8Array(base.length + pad + 2);
        out.set(base, 0);                                     /* sisanya sudah 0 */
        out[out.length - 2] = 0xff;
        out[out.length - 1] = 0xd9;
        return {
          bytes: out,
          action: 'JPEG terpotong: sisa gambar ditambal (' + Math.round(pad / 1024) + ' KB) dan ditutup penanda akhir',
        };
      });
    },

    /* PNG: buang sampah setelah chunk IEND (mis. berkas disambung/di-append) */
    repairPng(bytes) {
      if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) return null;
      const iend = this.lastIndexOfSeq(bytes, [0x49, 0x45, 0x4e, 0x44]);
      if (iend < 0) return null;
      const end = iend + 8;                                 /* IEND + CRC32 */
      if (end >= bytes.length) return null;
      return {
        bytes: bytes.subarray(0, end),
        action: 'sampah ' + (bytes.length - end) + ' byte setelah akhir PNG dibuang',
      };
    },

    /*
      Gabungan semua penyelamatan. Kembalikan daftar kandidat byte yang layak
      dicoba didekode, urut dari yang paling mungkin benar. Daftar kosong
      berarti berkasnya memang sudah bersih (tidak ada yang bisa diperbaiki).
      Bentuk kandidat: { bytes, actions: [alasan…] }
    */
    rescueCandidates(input) {
      let bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
      if (!bytes.length) return [];
      const actions = [];

      const decoded = this.fromBase64Text(bytes);
      if (decoded) { bytes = decoded; actions.push('isi berkas berupa teks base64/data URL, didekode dulu'); }

      const trimmed = this.trimLeadingJunk(bytes);
      if (trimmed) { bytes = trimmed.bytes; actions.push(trimmed.action); }

      const jpg = this.repairJpeg(bytes);
      if (jpg) { bytes = jpg.bytes; actions.push(jpg.action); }

      const png = this.repairPng(bytes);
      if (png) { bytes = png.bytes; actions.push(png.action); }

      const list = [];
      if (actions.length) list.push({ bytes, actions: actions.slice() });
      /* JPEG terpotong: beberapa ukuran tambalan, dicoba berurutan */
      this.padJpegVariants(bytes).forEach(v => {
        list.push({ bytes: v.bytes, actions: actions.concat([v.action]) });
      });
      return list;
    },

    /* Versi ringkas: kandidat pertama saja (atau null) */
    rescue(input) {
      const list = this.rescueCandidates(input);
      return list.length ? list[0] : null;
    },

    /*
      Pesan untuk kegagalan MEMBACA berkas (bukan mendekode). Kasus paling
      sering di Android/iOS: berkas dipilih dari Google Photos/Drive/iCloud,
      lalu referensinya kedaluwarsa sebelum sempat dibaca — browser melempar
      NotReadableError ("could not be read, typically due to permission
      problems…"). Yang perlu dilakukan pengguna: pilih ulang berkasnya.
    */
    readErrorMessage(err) {
      const name = (err && (err.name || '')) + '';
      const raw = (err && (err.message || '')) + '';
      const permission = name === 'NotReadableError' || name === 'SecurityError' ||
                         /could not be read|permission|NotReadable/i.test(raw);
      if (permission) {
        return 'Berkas gambarnya tidak bisa dibaca browser (izin/berkas sudah berubah sejak dipilih). ' +
               'Ini biasa terjadi kalau gambarnya diambil langsung dari Google Photos/Drive/iCloud. ' +
               'Pilih ulang gambarnya, atau simpan/unduh dulu ke penyimpanan HP lalu unggah dari Galeri/Files.';
      }
      if (name === 'NotFoundError' || /no longer exists|not found/i.test(raw)) {
        return 'Berkasnya sudah tidak ada di lokasi semula (mungkin sudah dipindah, diganti nama, atau dihapus). ' +
               'Pilih ulang gambarnya lewat tombol Ganti.';
      }
      return 'Berkas gambarnya gagal dibaca. Coba pilih ulang gambarnya, atau salin dulu ke penyimpanan HP lalu unggah lagi.';
    },
  };

  /* ==================================================================== */
  /* IMG — operasi citra berbasis { data, width, height } (RGBA atau gray) */
  /* ==================================================================== */

  const IMG = {
    /* ImageData apa adanya */
    create(data, width, height) {
      return { data, width, height };
    },

    /*
      Tumpuk RGBA di atas latar putih (alpha 0 = putih). Penting karena
      QRIS PNG sering berlatar transparan, sedangkan pemindai QR membaca
      piksel gelap/terang apa adanya.
    */
    flatten(imageData, bg) {
      bg = bg === undefined ? 255 : bg;
      const src = imageData.data;
      let opaque = true;
      for (let i = 3; i < src.length; i += 4) {
        if (src[i] !== 255) { opaque = false; break; }
      }
      if (opaque) return imageData;
      const out = new Uint8ClampedArray(src.length);
      for (let i = 0; i < src.length; i += 4) {
        const a = src[i + 3] / 255;
        out[i] = src[i] * a + bg * (1 - a);
        out[i + 1] = src[i + 1] * a + bg * (1 - a);
        out[i + 2] = src[i + 2] * a + bg * (1 - a);
        out[i + 3] = 255;
      }
      return { data: out, width: imageData.width, height: imageData.height };
    },

    /* RGBA → kanal tunggal (luma 0..255) */
    gray(imageData) {
      const src = imageData.data;
      const px = imageData.width * imageData.height;
      const out = new Uint8ClampedArray(px);
      for (let i = 0, p = 0; p < px; p++, i += 4) {
        const a = src[i + 3];
        if (a === 255) {
          out[p] = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
        } else {
          const k = a / 255, w = 255 * (1 - k);
          out[p] = 0.299 * (src[i] * k + w) + 0.587 * (src[i + 1] * k + w) + 0.114 * (src[i + 2] * k + w);
        }
      }
      return { data: out, width: imageData.width, height: imageData.height };
    },

    /* Kanala tunggal → RGBA (dipakai jsQR yang membaca RGBA) */
    toRGBA(grayImage) {
      const g = grayImage.data;
      const pix = grayImage.width * grayImage.height;
      const out = new Uint8ClampedArray(pix * 4);
      for (let p = 0, i = 0; p < pix; p++, i += 4) {
        const v = g[p];
        out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = 255;
      }
      return { data: out, width: grayImage.width, height: grayImage.height };
    },

    /* Ambang Otsu: cari nilai pemisah gelap/terang paling optimal */
    otsu(grayImage) {
      const g = grayImage.data;
      const hist = new Array(256).fill(0);
      for (let i = 0; i < g.length; i++) hist[g[i]]++;
      const total = g.length;
      let sum = 0;
      for (let t = 0; t < 256; t++) sum += t * hist[t];
      let sumB = 0, wB = 0, best = 0, threshold = 127;
      for (let t = 0; t < 256; t++) {
        wB += hist[t];
        if (!wB) continue;
        const wF = total - wB;
        if (!wF) break;
        sumB += t * hist[t];
        const mB = sumB / wB;
        const mF = (sum - sumB) / wF;
        const between = wB * wF * (mB - mF) * (mB - mF);
        if (between > best) { best = between; threshold = t; }
      }
      return threshold;
    },

    /* Kanala tunggal → hitam/putih murni */
    binarize(grayImage, threshold) {
      const g = grayImage.data;
      const t = threshold === undefined ? this.otsu(grayImage) : threshold;
      const out = new Uint8ClampedArray(g.length);
      for (let i = 0; i < g.length; i++) out[i] = g[i] > t ? 255 : 0;
      return { data: out, width: grayImage.width, height: grayImage.height };
    },

    /* Varian hitam/putih siap dipakai pemindai */
    thresholdVariant(imageData) {
      return this.toRGBA(this.binarize(this.gray(imageData)));
    },

    /* Ubah ukuran: perkecil pakai rata-rata area, perbesar pakai bilinear */
    scale(imageData, dw, dh) {
      const sw = imageData.width, sh = imageData.height;
      dw = Math.max(1, Math.round(dw));
      dh = Math.max(1, Math.round(dh));
      if (dw === sw && dh === sh) return imageData;
      const src = imageData.data;
      const out = new Uint8ClampedArray(dw * dh * 4);

      if (dw <= sw) { /* perkecil: rata-rata area */
        const xr = sw / dw, yr = sh / dh;
        for (let y = 0; y < dh; y++) {
          const y0 = Math.floor(y * yr);
          const y1 = Math.min(sh, Math.max(y0 + 1, Math.ceil((y + 1) * yr)));
          for (let x = 0; x < dw; x++) {
            const x0 = Math.floor(x * xr);
            const x1 = Math.min(sw, Math.max(x0 + 1, Math.ceil((x + 1) * xr)));
            let r = 0, g = 0, b = 0, n = 0;
            for (let yy = y0; yy < y1; yy++) {
              let idx = (yy * sw + x0) * 4;
              for (let xx = x0; xx < x1; xx++, idx += 4) { r += src[idx]; g += src[idx + 1]; b += src[idx + 2]; n++; }
            }
            const o = (y * dw + x) * 4;
            out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
          }
        }
        return { data: out, width: dw, height: dh };
      }

      /* perbesar: interpolasi bilinear */
      const xr = (sw - 1) / Math.max(1, dw - 1), yr = (sh - 1) / Math.max(1, dh - 1);
      for (let y = 0; y < dh; y++) {
        const sy = y * yr, y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), fy = sy - y0;
        for (let x = 0; x < dw; x++) {
          const sx = x * xr, x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), fx = sx - x0;
          const i00 = (y0 * sw + x0) * 4, i01 = (y0 * sw + x1) * 4;
          const i10 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
          const o = (y * dw + x) * 4;
          for (let c = 0; c < 3; c++) {
            const top = src[i00 + c] * (1 - fx) + src[i01 + c] * fx;
            const bot = src[i10 + c] * (1 - fx) + src[i11 + c] * fx;
            out[o + c] = top * (1 - fy) + bot * fy;
          }
          out[o + 3] = 255;
        }
      }
      return { data: out, width: dw, height: dh };
    },

    /* Perkecil hanya bila melebihi batas sisi terpanjang */
    fit(imageData, maxSide) {
      const longest = Math.max(imageData.width, imageData.height);
      if (longest <= maxSide) return imageData;
      const k = maxSide / longest;
      return this.scale(imageData, imageData.width * k, imageData.height * k);
    },

    /* Potong sebagian citra */
    crop(imageData, x, y, w, h) {
      x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
      w = Math.min(imageData.width - x, Math.round(w));
      h = Math.min(imageData.height - y, Math.round(h));
      if (w <= 0 || h <= 0) return null;
      const sw = imageData.width, src = imageData.data;
      const out = new Uint8ClampedArray(w * h * 4);
      for (let yy = 0; yy < h; yy++) {
        const from = ((y + yy) * sw + x) * 4;
        out.set(src.subarray(from, from + w * 4), yy * w * 4);
      }
      return { data: out, width: w, height: h };
    },

    /* Bagi citra menjadi petak-petak (dengan tumpang tindih) */
    tiles(imageData, cols, rows, overlap) {
      overlap = overlap === undefined ? 0.2 : overlap;
      const list = [];
      const tw = imageData.width / cols, th = imageData.height / rows;
      const ox = tw * overlap, oy = th * overlap;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = Math.max(0, c * tw - ox);
          const y = Math.max(0, r * th - oy);
          const x2 = Math.min(imageData.width, (c + 1) * tw + ox);
          const y2 = Math.min(imageData.height, (r + 1) * th + oy);
          const tile = this.crop(imageData, x, y, x2 - x, y2 - y);
          if (tile) list.push(tile);
        }
      }
      return list;
    },
  };

  /* ==================================================================== */
  /* SCAN — strategi pemindaian QR bertingkat                              */
  /* ==================================================================== */

  const SCAN = {
    MAX_ATTEMPTS: 30,
    MAX_SIDE: 1600,      /* batas sisi untuk pemindaian resolusi penuh */
    LIGHT_SIDE: 820,     /* resolusi ringan (cepat) */

    /*
      Susun daftar kandidat pemindaian, dari yang paling murah & paling
      sering berhasil (screenshot QRIS bersih) ke yang paling berat
      (foto besar, QR kecil di salah satu sudut, kontras rendah).
    */
    buildPlan(imageData) {
      const plan = [];
      const seen = new Set();
      const push = (label, image, key) => {
        if (!image || plan.length >= this.MAX_ATTEMPTS) return;
        if (image.width < 40 || image.height < 40) return;
        if (image.width * image.height > 4200000) return;
        if (seen.has(key)) return;
        seen.add(key);
        plan.push({ label, image });
      };
      const pushPair = (prefix, image, keyPrefix) => {
        push(prefix + ' (original)', image, keyPrefix + '-raw');
        push(prefix + ' (ambang)', IMG.thresholdVariant(image), keyPrefix + '-bin');
      };

      const longest = Math.max(imageData.width, imageData.height);
      const light = IMG.fit(imageData, this.LIGHT_SIDE);
      const full = IMG.fit(imageData, this.MAX_SIDE);

      /* 1. Resolusi ringan: kasus paling umum (screenshot QRIS) */
      pushPair('ringan', light, 'light');

      /* 2. Resolusi penuh bila berbeda dari yang ringan */
      if (full.width !== light.width || full.height !== light.height) pushPair('penuh', full, 'full');

      /* 3. Gambar kecil: perbesar supaya modul QR terbaca */
      if (longest < 600) {
        const k = longest < 300 ? 3 : 2;
        const big = IMG.scale(imageData, imageData.width * k, imageData.height * k);
        if (Math.max(big.width, big.height) <= 2400) pushPair('diperbesar ' + k + 'x', big, 'zoom' + k);
      }

      /* 4. Foto besar: QR bisa ada di mana saja → petak 2x2 lalu 3x3 */
      if (longest > 900) {
        const base = IMG.fit(imageData, this.MAX_SIDE);
        const t22 = IMG.tiles(base, 2, 2, 0.25);
        t22.forEach((tile, i) => {
          push('petak 2x2 #' + (i + 1) + ' (original)', tile, 't22-raw-' + i);
          push('petak 2x2 #' + (i + 1) + ' (ambang)', IMG.thresholdVariant(tile), 't22-bin-' + i);
        });
        const t33 = IMG.tiles(base, 3, 3, 0.25);
        t33.forEach((tile, i) => {
          push('petak 3x3 #' + (i + 1) + ' (original)', tile, 't33-raw-' + i);
          push('petak 3x3 #' + (i + 1) + ' (ambang)', IMG.thresholdVariant(tile), 't33-bin-' + i);
        });
      }

      return plan;
    },

    /*
      Jalankan pemindaian. hooks:
        onAttempt(n, total, label) — progres
        pause()                     — dipanggil berkala agar UI tetap hidup
        cancelled()                 — kembalikan true untuk berhenti
      Hasil: { data, attempts, total, label } atau { data: null, ... }
    */
    async scan(imageData, hooks) {
      hooks = hooks || {};
      const jsQR = libJsQR();
      const flat = IMG.flatten(imageData);
      if (!flat.width || !flat.height) throw new Error('Dimensi gambar tidak terbaca');

      const plan = this.buildPlan(flat);
      for (let i = 0; i < plan.length; i++) {
        if (typeof hooks.cancelled === 'function' && hooks.cancelled()) {
          return { data: null, attempts: i, total: plan.length, cancelled: true };
        }
        const step = plan[i];
        if (typeof hooks.onAttempt === 'function') hooks.onAttempt(i + 1, plan.length, step.label);
        let code = null;
        try {
          code = jsQR(step.image.data, step.image.width, step.image.height, { inversionAttempts: 'attemptBoth' });
        } catch (e) { code = null; }
        if (code && code.data) {
          return { data: code.data, attempts: i + 1, total: plan.length, label: step.label };
        }
        if (typeof hooks.pause === 'function' && (i % 2 === 1)) await hooks.pause();
      }
      return { data: null, attempts: plan.length, total: plan.length };
    },
  };

  /* ==================================================================== */
  /* EMV — payload QRIS (TLV EMV MPM + CRC16/CCITT)                        */
  /* ==================================================================== */

  const EMV = {
    textEncoder,
    textDecoder,

    byteLen(str) { return this.textEncoder.encode(str).length; },

    /*
      CRC16/CCITT: poly 0x1021, init 0xFFFF, tanpa refleksi (wajib QRIS).
      Dihitung atas byte UTF-8 payload — sama dengan byte yang benar-benar
      tertulis di dalam QR, jadi nama merchant non-ASCII tetap benar.
    */
    crc16(str) {
      const bytes = this.textEncoder.encode(str);
      let crc = 0xFFFF;
      for (let i = 0; i < bytes.length; i++) {
        crc ^= bytes[i] << 8;
        for (let j = 0; j < 8; j++) {
          crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
        }
      }
      return crc.toString(16).toUpperCase().padStart(4, '0');
    },

    /*
      Parse TLV menjadi [{id, value}] (urutan asli dipertahankan).
      Dihitung atas byte UTF-8 karena panjang field di TLV adalah jumlah byte —
      penting agar nama merchant non-ASCII tidak menggeser posisi field.
    */
    parseTLV(str) {
      const bytes = this.textEncoder.encode(str);
      const fields = [];
      const decode = (from, to) => this.textDecoder.decode(bytes.subarray(from, to));
      let pos = 0;
      while (pos < bytes.length) {
        if (pos + 4 > bytes.length) {
          throw new Error('Format data QRIS tidak valid (TLV rusak)');
        }
        const id = decode(pos, pos + 2);
        if (!/^\d{2}$/.test(id)) {
          throw new Error('Format data QRIS tidak valid (TLV rusak)');
        }
        const len = parseInt(decode(pos + 2, pos + 4), 10);
        if (Number.isNaN(len)) {
          throw new Error('Format data QRIS tidak valid (TLV rusak)');
        }
        if (pos + 4 + len > bytes.length) {
          throw new Error('Format data QRIS tidak valid (panjang field tidak cocok)');
        }
        fields.push({ id, value: decode(pos + 4, pos + 4 + len) });
        pos += 4 + len;
      }
      return fields;
    },

    /* Susun ulang TLV (urut naik, CRC tag 63 selalu terakhir) */
    buildTLV(fields) {
      const body = fields
        .filter(f => f.id !== '63')
        .sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10))
        .map(f => f.id + String(this.byteLen(f.value)).padStart(2, '0') + f.value)
        .join('');
      return body + '6304' + this.crc16(body + '6304');
    },

    /* Ubah QRIS statis → dinamis bernominal `amount` (string angka) */
    makeDynamic(staticStr, amount) {
      if (typeof staticStr !== 'string' || !staticStr.trim()) {
        throw new Error('Data QRIS kosong');
      }
      if (!/^\d+$/.test(String(amount))) {
        throw new Error('Nominal tidak valid');
      }
      const fields = this.parseTLV(staticStr.trim());
      const map = {};
      fields.forEach(f => { map[f.id] = f; });

      if (!map['00'] || map['00'].value !== '01') {
        throw new Error('QR yang terbaca bukan kode pembayaran EMV/QRIS');
      }
      if (map['53'] && map['53'].value !== '360' && map['58'] && map['58'].value !== 'ID') {
        throw new Error('QR yang terbaca bukan QRIS Indonesia (bukan mata uang IDR)');
      }
      if (!map['59']) {
        throw new Error('Data merchant pada QRIS tidak lengkap (tag 59 hilang)');
      }

      /* Tag 01: 11 = statis, 12 = dinamis */
      if (map['01']) map['01'].value = '12';
      else { map['01'] = { id: '01', value: '12' }; fields.push(map['01']); }

      /* Tag 54: nominal transaksi (ganti bila sudah ada) */
      if (map['54']) map['54'].value = amount;
      else { map['54'] = { id: '54', value: amount }; fields.push(map['54']); }

      /* Tag 55 (tip/convenience fee) tidak relevan untuk nominal tetap */
      if (map['55']) fields.splice(fields.indexOf(map['55']), 1);

      return {
        qrisString: this.buildTLV(fields),
        merchantName: map['59'] ? map['59'].value : '',
        merchantCity: map['60'] ? map['60'].value : '',
        currency: map['53'] ? map['53'].value : '',
        country: map['58'] ? map['58'].value : '',
      };
    },
  };

  /* ==================================================================== */
  /* RENDER — QR baru dari payload (matriks modul, lalu PNG)               */
  /* ==================================================================== */

  const RENDER = {
    /* Matriks modul QR murni (tanpa canvas) */
    matrix(text, ecLevel) {
      const qrcode = libQrcode();
      const qr = qrcode(0, ecLevel || 'M');
      qr.addData(text);
      qr.make();
      const count = qr.getModuleCount();
      return {
        count,
        isDark(r, c) { return qr.isDark(r, c); },
      };
    },

    /* Gambar matriks QR ke konteks canvas (sudut bisa membulat lewat clip) */
    drawMatrix(ctx, matrix, x, y, size, opts) {
      opts = opts || {};
      const quiet = opts.quiet === undefined ? 2 : opts.quiet;
      const dark = opts.dark || '#000000';
      const light = opts.light || '#ffffff';
      const radius = opts.radius || 0;
      const count = matrix.count;
      const total = count + quiet * 2;
      /* Presisi: origin & ukuran dibulatkan ke piksel utuh dulu. */
      const px = Math.round(x);
      const py = Math.round(y);
      const ps = Math.round(size);
      const cellF = ps / total;

      ctx.save();
      if (radius > 0) {
        roundRectPath(ctx, px, py, ps, ps, Math.min(radius, ps / 2));
        ctx.clip();
      }
      ctx.fillStyle = light;
      ctx.fillRect(px, py, ps, ps);
      /*
        Modul rata & presisi: batas tiap modul dihitung dengan Math.round dari
        posisi idealnya, jadi antar-modul TIDAK ada celah/overlap (tidak bolong
        atau gompel) dan lebarnya seragam (selisih maksimal 1px hanya bila
        ukuran tidak habis dibagi — tepi tetap tajam, tanpa anti-alias abu-abu).
      */
      ctx.fillStyle = dark;
      for (let r = 0; r < count; r++) {
        const y0 = py + Math.round((r + quiet) * cellF);
        const y1 = py + Math.round((r + 1 + quiet) * cellF);
        for (let c = 0; c < count; c++) {
          if (matrix.isDark(r, c)) {
            const x0 = px + Math.round((c + quiet) * cellF);
            const x1 = px + Math.round((c + 1 + quiet) * cellF);
            ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
          }
        }
      }
      ctx.restore();
    },

    /* PNG data URL; butuh canvas (browser) — bisa disuntik lewat opts.createCanvas */
    renderPNG(text, opts) {
      opts = opts || {};
      const cell = opts.cell || 8;
      const quiet = opts.quiet === undefined ? 4 : opts.quiet;
      const matrix = opts.matrix || this.matrix(text, opts.ecLevel);
      const count = matrix.count;
      const size = (count + quiet * 2) * cell;

      const createCanvas = opts.createCanvas || function () {
        if (typeof document === 'undefined') throw new Error('Canvas tidak tersedia');
        return document.createElement('canvas');
      };
      const canvas = createCanvas();
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      this.drawMatrix(ctx, matrix, 0, 0, size, {
        quiet: quiet,
        dark: opts.dark || '#000000',
        light: opts.light || '#ffffff',
        radius: opts.radius || 0,
      });
      return canvas.toDataURL('image/png');
    },
  };

  /* ==================================================================== */
  /* THEME — tempel QR + nominal ke background anime/kartu kustom          */
  /* ==================================================================== */

  /*
    Tema kartu SELALU bergambar (tema "QR polos" sudah dihapus):
      - type 'image'  : layout tetap dari katalog assets/themes/themes.json
      - type 'custom' : background unggahan user + posisi QR (center/left/right)

    Bentuk tema 'image':
      { id, type:'image', image, width, height,
        qr: { x, y, size, padding?, radius? },
        nominal?: { x, y, align, maxWidth, fontSize, color, strokeColor,
                    strokeWidth, prefix, shadow },
        merchant?: { enabled, name, city } }
  */
  const THEME = {
    formatAmount(amount, prefix) {
      const n = parseInt(String(amount || '0'), 10) || 0;
      const formatted = n.toLocaleString('id-ID');
      return (prefix === undefined ? 'Rp ' : prefix) + formatted;
    },

    /*
      SEMUA teks kartu digambar dengan textBaseline 'middle': `y` = titik
      tengah baris. lineHalf() menaksir setengah tinggi baris dari fontSize.
    */
    lineHalf(spec) {
      const fs = (spec && spec.fontSize) || 32;
      return Math.max(8, Math.round(fs * 0.52));
    },

    /* Jarak vertikal minimal antara dua baris supaya tidak bertumpuk */
    lineGap(upper, lower) {
      const fs = Math.max((upper && upper.fontSize) || 24, (lower && lower.fontSize) || 20);
      return Math.max(6, Math.round(fs * 0.26));
    },

    /*
      Ukuran font tiap baris blok teks + tinggi total bloknya:
          baris 1 : nominal      (paling besar)
          baris 2 : nama toko
          baris 3 : kota/kabupaten
      Dipakai bersama oleh layout kustom dan lapisan pengaman di compose().
    */
    textBlockMetrics(fontSize) {
      const amount = Math.max(18, Math.round(fontSize || 32));
      const name = Math.max(15, Math.round(amount * 0.55));
      const city = Math.max(12, Math.round(name * 0.75));
      const amountHalf = this.lineHalf({ fontSize: amount });
      const nameHalf = this.lineHalf({ fontSize: name });
      const cityHalf = this.lineHalf({ fontSize: city });
      const gap1 = this.lineGap({ fontSize: amount }, { fontSize: name });
      const gap2 = this.lineGap({ fontSize: name }, { fontSize: city });
      return {
        amount, name, city, amountHalf, nameHalf, cityHalf, gap1, gap2,
        blockHeight: amountHalf * 2 + gap1 + nameHalf * 2 + gap2 + cityHalf * 2,
      };
    },

    /*
      Pengaman blok teks kartu — urutannya SELALU nominal → nama toko → kota:
        1) baris yang saling bertabrakan didorong ke bawah,
        2) seluruh blok digeser ke atas bila melewati batas bawah kanvas.
      `lines` boleh berisi null (baris yang tidak digambar); posisi null tetap
      null di hasil. Spec asli (themes.json) tidak diubah — hasilnya salinan.
    */
    stackText(lines, canvasHeight, marginBottom) {
      const list = (lines || []).map(spec => (spec ? Object.assign({}, spec) : null));
      const filled = list.filter(Boolean);
      if (!filled.length) return list;

      for (let i = 0; i < filled.length - 1; i++) {
        const atas = filled[i];
        const bawah = filled[i + 1];
        const minY = atas.y + this.lineHalf(atas) + this.lineGap(atas, bawah) + this.lineHalf(bawah);
        if (bawah.y < minY) bawah.y = minY;
      }

      const bottom = marginBottom === undefined ? 10 : marginBottom;
      const last = filled[filled.length - 1];
      const overflow = last.y + this.lineHalf(last) + bottom - canvasHeight;
      if (overflow > 0) {
        /* geser blok ke atas, tapi jangan sampai nominal keluar dari atas kanvas */
        const shift = Math.min(overflow, Math.max(0, filled[0].y - this.lineHalf(filled[0])));
        if (shift > 0) filled.forEach(spec => { spec.y -= shift; });
      }
      return list;
    },

    /* Hitung kotak QR untuk background kustom tanpa metadata layout */
    layoutForCustom(width, height, position) {
      position = position || 'center';
      const short = Math.min(width, height);
      const size = Math.round(short * (position === 'center' ? 0.42 : 0.38));
      const metrics = this.textBlockMetrics(Math.max(22, Math.round(size * 0.09)));
      const bottomMargin = Math.max(10, Math.round(height * 0.012));
      let x, y;
      if (position === 'left') {
        x = Math.round(width * 0.08);
        y = Math.round((height - size) / 2 - height * 0.04);
      } else if (position === 'right') {
        x = Math.round(width - size - width * 0.08);
        y = Math.round((height - size) / 2 - height * 0.04);
      } else {
        x = Math.round((width - size) / 2);
        y = Math.round(height * 0.22);
      }
      /* QR + seluruh blok teks (nominal, toko, kota) harus muat di kanvas */
      y = Math.max(8, Math.min(y, height - size - metrics.blockHeight - bottomMargin));
      return {
        width, height,
        qr: { x, y, size, padding: Math.round(size * 0.04), radius: 8 },
        nominal: {
          x: x + size / 2,
          y: y + size + metrics.gap1 + metrics.amountHalf,
          align: 'center',
          maxWidth: Math.round(size * 1.15),
          fontSize: metrics.amount,
          color: '#FFFFFF',
          strokeColor: 'rgba(0,0,0,0.65)',
          strokeWidth: 4,
          prefix: 'Rp ',
          shadow: true,
        },
      };
    },

    /* Gambar teks nominal (dengan stroke/bayangan opsional) */
    drawText(ctx, text, spec) {
      if (!spec || !text) return;
      const x = spec.x;
      const y = spec.y;
      const align = spec.align || 'center';
      const maxWidth = spec.maxWidth || 400;
      let fontSize = spec.fontSize || 36;
      const color = spec.color || '#FFFFFF';
      const strokeColor = spec.strokeColor || '';
      const strokeWidth = spec.strokeWidth || 0;
      const fontFamily = spec.fontFamily || 'system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
      const weight = spec.fontWeight || '700';
      /* transform opsional: 'uppercase' / 'lowercase' / 'capitalize' */
      const transform = spec.transform || '';
      let label = text;
      if (transform === 'uppercase') label = text.toUpperCase();
      else if (transform === 'lowercase') label = text.toLowerCase();
      else if (transform === 'capitalize') {
        label = text.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.substr(1).toLowerCase());
      }

      ctx.save();
      ctx.textAlign = align;
      ctx.textBaseline = 'middle';

      /* perkecil font bila teks kepanjangan */
      for (let i = 0; i < 12; i++) {
        ctx.font = weight + ' ' + fontSize + 'px ' + fontFamily;
        if (ctx.measureText(label).width <= maxWidth) break;
        fontSize = Math.max(10, Math.floor(fontSize * 0.92));
      }

      if (spec.shadow) {
        ctx.shadowColor = spec.shadowColor || 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = Math.max(3, Math.round(fontSize * 0.25));
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = Math.max(1, Math.round(fontSize * 0.06));
      }
      if (strokeWidth > 0 && strokeColor) {
        ctx.lineWidth = strokeWidth;
        ctx.strokeStyle = strokeColor;
        ctx.lineJoin = 'round';
        ctx.strokeText(label, x, y);
      }
      ctx.fillStyle = color;
      ctx.fillText(label, x, y);
      ctx.restore();
    },

    drawNominal(ctx, text, spec) {
      this.drawText(ctx, text, spec);
    },

    /* Susun letak nama toko + kota untuk background unggahan sendiri:
       tepat di BAWAH baris nominal, kota di baris paling bawah. */
    merchantLayoutForCustom(width, height, nominalSpec) {
      const metrics = this.textBlockMetrics((nominalSpec && nominalSpec.fontSize) || 32);
      const centerX = (nominalSpec && nominalSpec.x) ? nominalSpec.x : Math.round(width / 2);
      const maxW = Math.min(
        (nominalSpec && nominalSpec.maxWidth) ? nominalSpec.maxWidth : Math.round(width * 0.7),
        Math.round(width * 0.86)
      );
      const align = (nominalSpec && nominalSpec.align) || 'center';
      const amountY = (nominalSpec && nominalSpec.y) ? nominalSpec.y : Math.round(height * 0.78);
      const amountHalf = this.lineHalf(nominalSpec || { fontSize: metrics.amount });
      const nameY = amountY + amountHalf + metrics.gap1 + metrics.nameHalf;
      const cityY = nameY + metrics.nameHalf + metrics.gap2 + metrics.cityHalf;
      return {
        enabled: true,
        name: {
          x: centerX, y: nameY,
          align,
          maxWidth: maxW,
          fontSize: metrics.name,
          color: '#FFFFFF',
          strokeColor: 'rgba(0,0,0,0.7)',
          strokeWidth: 3,
          shadow: true,
          fontWeight: '700',
          transform: 'uppercase',
        },
        city: {
          x: centerX, y: cityY,
          align,
          maxWidth: maxW,
          fontSize: metrics.city,
          color: 'rgba(255,255,255,0.88)',
          strokeColor: 'rgba(0,0,0,0.65)',
          strokeWidth: 2,
          shadow: true,
          fontWeight: '500',
        },
      };
    },

    /*
      Susun kartu bertema. opts:
        text / matrix   payload QR
        theme           objek tema (image | custom)
        background      HTMLImageElement/ImageBitmap (wajib untuk image/custom)
        amount          string angka nominal
        merchantName, merchantCity
        createCanvas    opsional (uji Node)
      Hasil: data URL PNG
    */
    compose(opts) {
      opts = opts || {};
      const theme = opts.theme || {};
      const qrTheme = theme && theme.qr;
      /* Logo tengah menutup sebagian modul → pakai koreksi kesalahan tertinggi
         ('H' ≈ 30% pemulihan) supaya QR tetap terpindai. */
      const ecLevel = opts.ecLevel || ((qrTheme && qrTheme.logo) ? 'H' : 'M');
      const matrix = opts.matrix || RENDER.matrix(opts.text, ecLevel);
      const createCanvas = opts.createCanvas || function () {
        if (typeof document === 'undefined') throw new Error('Canvas tidak tersedia');
        return document.createElement('canvas');
      };

      let width, height, qrSpec, nominalSpec, merchantSpec, bg, bgColor = '';

      if (!theme || !theme.type || theme.type === 'plain') {
        /* Tema polos sudah dihapus: kartu QRIS wajib punya background gambar. */
        throw new Error('Tema kartu wajib bergambar — pilih kartu Rimuru atau unggah background sendiri.');
      } else if (theme.type === 'custom') {
        bg = opts.background;
        if (!bg) throw new Error('Background kustom belum dimuat');
        width = bg.naturalWidth || bg.width || theme.width;
        height = bg.naturalHeight || bg.height || theme.height;
        const auto = this.layoutForCustom(width, height, theme.position || 'center');
        qrSpec = auto.qr;
        nominalSpec = Object.assign({}, auto.nominal, theme.nominal || {});
        merchantSpec = this.merchantLayoutForCustom(width, height, nominalSpec);
        bgColor = '';
      } else {
        bg = opts.background;
        if (!bg) throw new Error('Gambar tema belum dimuat');
        width = theme.width || bg.naturalWidth || bg.width;
        height = theme.height || bg.naturalHeight || bg.height;
        qrSpec = theme.qr ? Object.assign({}, theme.qr) : null;
        nominalSpec = theme.nominal ? Object.assign({}, theme.nominal) : null;
        merchantSpec = theme.merchant ? JSON.parse(JSON.stringify(theme.merchant)) : { enabled: false };
        bgColor = '';
      }

      if (!qrSpec || !qrSpec.size) throw new Error('Layout QR pada tema tidak lengkap');

      const canvas = createCanvas();
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');

      /* latar */
      if (bg) {
        ctx.drawImage(bg, 0, 0, width, height);
      } else if (bgColor) {
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, width, height);
      }

      /*
        cover (opsional): persegi yang WAJIB ditutup putih penuh sebelum QR
        digambar — dipakai bila artwork background memuat contoh QR cetakan.
        Koordinatnya presisi mengikuti tepi kotak putih artwork supaya tidak
        ada sisa modul cetakan yang mengintip (gompel/bolong di pinggir).
      */
      if (qrSpec.cover) {
        const cv = qrSpec.cover;
        ctx.fillStyle = qrSpec.light || '#ffffff';
        ctx.fillRect(Math.round(cv.x), Math.round(cv.y), Math.round(cv.w), Math.round(cv.h));
      }

      /* slot QR: isi putih dulu, lalu gambar modul */
      const pad = qrSpec.padding === undefined ? 0 : qrSpec.padding;
      const slotX = Math.round(qrSpec.x);
      const slotY = Math.round(qrSpec.y);
      const slotSize = Math.round(qrSpec.size);
      const inner = Math.max(8, slotSize - pad * 2);
      const qrX = slotX + (slotSize - inner) / 2;
      const qrY = slotY + (slotSize - inner) / 2;

      ctx.save();
      const radius = qrSpec.radius || 0;
      if (radius > 0) {
        roundRectPath(ctx, slotX, slotY, slotSize, slotSize, Math.min(radius, slotSize / 2));
        ctx.clip();
      }
      ctx.fillStyle = qrSpec.light || '#ffffff';
      ctx.fillRect(slotX, slotY, slotSize, slotSize);
      ctx.restore();

      RENDER.drawMatrix(ctx, matrix, qrX, qrY, inner, {
        quiet: 1,
        radius: Math.max(0, (qrSpec.radius || 0) - 2),
        dark: (qrSpec.dark || '#000000'),
        light: qrSpec.light || '#ffffff',
      });

      /*
        Logo tengah (opsional): kotak putih membulat + gambar logo diclip
        persegi, tepat di pusat QR. opts.logo = HTMLImageElement/canvas.
      */
      const logoSpec = qrSpec.logo;
      if (logoSpec && opts.logo) {
        const logoSize = Math.max(24, Math.round(inner * (logoSpec.scale || 0.22)));
        const border = logoSpec.border === undefined
          ? Math.max(4, Math.round(logoSize * 0.12))
          : Math.max(0, Math.round(logoSpec.border));
        const cx = qrX + inner / 2;
        const cy = qrY + inner / 2;
        const bw = logoSize + border * 2;
        const bx = Math.round(cx - bw / 2);
        const by = Math.round(cy - bw / 2);
        ctx.save();
        roundRectPath(ctx, bx, by, bw, bw, (logoSpec.radius || 0) + border);
        ctx.clip();
        ctx.fillStyle = qrSpec.light || '#ffffff';
        ctx.fillRect(bx, by, bw, bw);
        ctx.restore();
        const lx = bx + border;
        const ly = by + border;
        ctx.save();
        roundRectPath(ctx, lx, ly, logoSize, logoSize, logoSpec.radius || 0);
        ctx.clip();
        ctx.drawImage(opts.logo, lx, ly, logoSize, logoSize);
        ctx.restore();
      }

      /*
        Blok teks kartu — urutannya SELALU dari atas ke bawah:
          1) nominal (Rp …)       — di bawah label "NOMINAL" milik background,
          2) nama toko            (tag 59),
          3) kota / kabupaten     (tag 60).
        stackText() merapikan posisinya supaya baris tidak saling menimpa
        (mis. nominal tidak lagi menabrak label) dan tetap di dalam kanvas.
      */
      const baris = this.stackText([
        (nominalSpec && opts.amount != null && opts.amount !== '') ? nominalSpec : null,
        (merchantSpec && merchantSpec.enabled) ? merchantSpec.name : null,
        (merchantSpec && merchantSpec.enabled) ? merchantSpec.city : null,
      ], height);

      if (baris[0]) {
        this.drawNominal(ctx, this.formatAmount(opts.amount, baris[0].prefix), baris[0]);
      }
      if (baris[1] && opts.merchantName) {
        this.drawText(ctx, String(opts.merchantName), baris[1]);
      }
      if (baris[2] && opts.merchantCity) {
        this.drawText(ctx, String(opts.merchantCity), baris[2]);
      }

      return canvas.toDataURL('image/png');
    },
  };

  return { PROBE, BYTES, IMG, SCAN, EMV, RENDER, THEME };
});
