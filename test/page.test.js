/* Uji halaman: berkas yang dirujuk ada, dan semua id elemen yang dipakai JS benar-benar ada */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./t.js');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

test('index.html: semua berkas skrip yang dirujuk ada', () => {
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]);
  assert.ok(srcs.length >= 4, 'ada skrip vendor + logika inti, dapat ' + srcs.length);
  assert.ok(srcs.includes('src/qris-core.js'), 'logika inti dimuat');
  srcs.forEach(src => {
    assert.ok(fs.existsSync(path.join(ROOT, src)), 'berkas hilang: ' + src);
  });
});

test('index.html: jumlah tag <script> seimbang', () => {
  const open = (html.match(/<script\b/g) || []).length;
  const close = (html.match(/<\/script>/g) || []).length;
  assert.strictEqual(open, close);
});

test('index.html: setiap getElementById punya elemen pasangannya', () => {
  const ids = new Set([...html.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]));
  assert.ok(ids.size > 10, 'ada cukup banyak elemen, dapat ' + ids.size);
  ids.forEach(id => {
    assert.ok(html.includes('id="' + id + '"'), 'elemen #' + id + ' tidak ada di HTML');
  });
});

test('index.html: elemen penting untuk unggah gambar tersedia', () => {
  ['fileInput', 'fileDropzone', 'filePreview', 'fileNote', 'fileClear', 'fileReplace', 'errorHints']
    .forEach(id => assert.ok(html.includes('id="' + id + '"'), 'elemen #' + id + ' hilang'));
});

test('index.html: pemilih berkas menerima format HEIC/HEIF/AVIF', () => {
  const accept = (html.match(/<input type="file"[^>]*accept="([^"]+)"/) || [])[1] || '';
  ['.heic', '.heif', '.avif', 'image/*'].forEach(ext => {
    assert.ok(accept.includes(ext), 'accept harus memuat ' + ext + ' (dapat: ' + accept + ')');
  });
});

test('index.html: dekoder HEIC dimuat dari berkas lokal, bukan CDN', () => {
  assert.ok(html.includes("vendor/libheif-bundle.js"), 'menunjuk ke dekoder lokal');
  assert.ok(!/https?:\/\/[^"']*libheif/.test(html), 'tidak memakai CDN untuk dekoder');
  assert.ok(fs.existsSync(path.join(ROOT, 'vendor/libheif-bundle.js')), 'berkas dekoder ada');
  assert.ok(fs.existsSync(path.join(ROOT, 'vendor/libheif.LICENSE')), 'lisensi dekoder disertakan');
});

test('index.html: skrip inline bebas galat sintaks', () => {
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(blocks.length >= 1, 'ada skrip inline');
  blocks.forEach((code, i) => {
    try {
      new Function(code);   /* dikompilasi, tidak dijalankan */
    } catch (err) {
      throw new Error('blok skrip inline #' + (i + 1) + ': ' + err.message);
    }
  });
});

test('index.html: kurung kurawal CSS seimbang', () => {
  const css = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
  assert.ok(css.length > 2000, 'ada gaya halaman');
  assert.strictEqual((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
});

test('src/qris-core.js: jalan sebagai skrip klasik (window.QRISCORE terisi)', () => {
  /* Di browser, berkas ini dimuat lewat <script src>, bukan require() */
  const vm = require('vm');
  const code = fs.readFileSync(path.join(ROOT, 'src', 'qris-core.js'), 'utf8');
  const sandbox = { console, TextEncoder, TextDecoder };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'qris-core.js' });

  assert.strictEqual(typeof sandbox.QRISCORE, 'object', 'QRISCORE tersedia sebagai global');
  ['PROBE', 'IMG', 'SCAN', 'EMV', 'RENDER', 'THEME'].forEach(bagian => {
    assert.ok(sandbox.QRISCORE[bagian], 'bagian ' + bagian + ' tersedia');
  });
  assert.strictEqual(typeof sandbox.QRISCORE.EMV.makeDynamic, 'function');
  assert.strictEqual(typeof sandbox.QRISCORE.THEME.compose, 'function');
});

test('vendor/libheif-bundle.js: siap sebagai skrip klasik tanpa jaringan', () => {
  const vm = require('vm');
  const code = fs.readFileSync(path.join(ROOT, 'vendor', 'libheif-bundle.js'), 'utf8');
  const sandbox = { console, WebAssembly, TextDecoder, TextEncoder, setTimeout, clearTimeout, Math, Date, JSON };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'libheif-bundle.js' });
  assert.strictEqual(typeof sandbox.libheif, 'function', 'tersedia sebagai fungsi global');
});

test('index.html: tidak ada panggilan jaringan selain URL yang diisi pengguna', () => {
  assert.ok(!/fetch\('https?:\/\//.test(html), 'tidak ada fetch ke alamat tetap');
  assert.ok(!/XMLHttpRequest/.test(html));
});

test('index.html: gagal baca berkas (izin) dibedakan dari gagal dekode', () => {
  assert.ok(html.includes('READ_HINTS'), 'ada petunjuk khusus kegagalan membaca berkas');
  assert.ok(html.includes('BYTES.readErrorMessage'), 'pesan kegagalan baca diambil dari core');
  assert.ok(html.includes('readWithFileReader'), 'ada jalur cadangan FileReader saat arrayBuffer gagal');
});

test('index.html: input file tidak dikosongkan sebelum gambar selesai dibaca', () => {
  assert.ok(/function resetFileState\(options\)/.test(html), 'reset state harus bisa memilih apakah input dikosongkan');
  assert.ok(html.includes('resetFileState({ clearInput: false })'), 'saat menerima File baru, izin input harus dipertahankan');

  const start = html.indexOf('async function selectFile(file)');
  const beforeRead = html.slice(start, html.indexOf('const data = await IMAGELOAD.load(file)', start));
  assert.ok(!beforeRead.includes("fileInput.value = ''"), 'selectFile tidak boleh menghapus value input sebelum File dibaca');
});

test('index.html: File asli disalin ke Blob stabil sebelum didekode berulang', () => {
  assert.ok(html.includes('const stableBlob = new Blob([raw]'), 'ada Blob memori dari byte File');
  assert.ok(html.includes('nativeSource(stableBlob)'), 'decode native memakai Blob stabil');
  assert.ok(html.includes('heifImageData(stableBlob)'), 'decode HEIF memakai Blob stabil');
});

test('index.html: berkas rusak diperbaiki otomatis sebelum menyerah', () => {
  assert.ok(html.includes('BYTES.rescueCandidates'), 'mencoba kandidat perbaikan byte');
  assert.ok(html.includes('rescueSource'), 'kandidat hasil perbaikan didekode ulang');
  assert.ok(html.includes('BROKEN_HINTS'), 'petunjuk khusus berkas tidak utuh');
  assert.ok(/repaired/.test(html), 'hasil perbaikan dilaporkan ke pengguna');
});

test('index.html: tema kartu dipakai otomatis, tanpa pemilih di halaman', () => {
  ['themeGrid', 'themeCustom', 'bgInput', 'bgDropzone', 'bgPosRow']
    .forEach(id => assert.ok(!html.includes('id="' + id + '"'), 'pemilih tema masih ada: #' + id));
  assert.ok(!html.includes('Upload sendiri'), 'opsi unggah background sendiri masih ada di halaman');
  assert.ok(!html.includes('Tema Kartu QRIS'), 'label pemilih tema masih terlihat');
  assert.ok(html.includes('CORE.THEME.compose'), 'hasil digambar lewat THEME.compose');
  assert.ok(html.includes('assets/themes/'), 'katalog tema dimuat dari folder lokal');
  assert.ok(html.includes('initThemes'), 'katalog tema diinisialisasi');
  assert.ok(html.includes('getSelectedTheme'), 'tema Rimuru dipilih otomatis');
});

test('assets/themes: katalog berisi kartu Rimuru, tanpa tema polos', () => {
  const dir = path.join(ROOT, 'assets', 'themes');
  const metaPath = path.join(dir, 'themes.json');
  assert.ok(fs.existsSync(metaPath), 'themes.json ada');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert.ok(Array.isArray(meta.themes) && meta.themes.length >= 1, 'ada minimal 1 tema');
  assert.ok(
    !meta.themes.some(t => t.type === 'plain' || t.id === 'plain'),
    'tema polos sudah dihapus dari katalog'
  );
  const rimuru = meta.themes.find(t => t.id === 'tiyanstore-rimuru');
  assert.ok(rimuru, 'kartu Rimuru tersedia');
  meta.themes.forEach(t => {
    assert.strictEqual(t.type, 'image', t.id + ' harus tema bergambar');
    assert.ok(t.image, t.id + ' punya berkas gambar');
    assert.ok(fs.existsSync(path.join(dir, t.image)), 'gambar tema hilang: ' + t.image);
    assert.ok(t.thumb && fs.existsSync(path.join(dir, t.thumb)), 'thumbnail hilang: ' + t.thumb);
    assert.ok(t.qr && t.qr.size > 0, t.id + ' punya layout QR');
    assert.ok(t.nominal && t.nominal.y > t.qr.y, t.id + ' nominal di bawah QR');
    assert.ok(t.merchant && t.merchant.enabled !== false, t.id + ' punya blok nama toko + kota');

    /* urutan baris: nominal → nama toko → kota, jaraknya tidak menabrak */
    const garis = [t.nominal, t.merchant.name, t.merchant.city];
    assert.ok(garis[1] && garis[2], t.id + ' harus punya name & city');
    /* setengah tinggi baris ditaksir dari fontSize (semua teks pakai textBaseline 'middle') */
    const half = spec => Math.max(8, Math.round(spec.fontSize * 0.52));
    garis.forEach((spec, i) => {
      assert.ok(spec.fontSize > 0, t.id + ' baris ke-' + (i + 1) + ' punya fontSize');
      assert.ok(spec.y + half(spec) <= t.height, t.id + ' baris ke-' + (i + 1) + ' masih di dalam kartu');
      assert.ok(spec.x - spec.maxWidth / 2 >= 0 && spec.x + spec.maxWidth / 2 <= t.width,
        t.id + ' baris ke-' + (i + 1) + ' muat di lebar kartu');
      if (i === 0) return;
      const bawahSebelumnya = garis[i - 1].y + half(garis[i - 1]);
      assert.ok(spec.y - half(spec) >= bawahSebelumnya,
        t.id + ': baris ke-' + (i + 1) + ' mulai (y ' + (spec.y - half(spec)) +
        ') setelah baris ke-' + i + ' selesai (y ' + bawahSebelumnya + ')');
    });
    if (t.id === 'tiyanstore-rimuru') {
      /* baris terakhir label/garis "NOMINAL" pada background Rimuru (hasil ukur piksel) */
      const labelNominal = 944;
      assert.ok(garis[0].y - half(garis[0]) > labelNominal,
        t.id + ': nominal tidak menabrak label NOMINAL di background');
    }
  });
});

test('index.html: opsi tema polos dan upload sendiri dibuang, Rimuru otomatis', () => {
  assert.ok(!html.includes('Polos (QR saja)'), 'kartu polos masih ada di halaman');
  assert.ok(!/type:\s*'plain'/.test(html), 'masih ada tema bertipe plain di halaman');
  assert.ok(!html.includes('layoutForPlain'), 'layout polos masih dipakai');
  assert.ok(!html.includes('CORE.RENDER.renderPNG'), 'halaman masih menggambar QR polos');
  assert.ok(!html.includes('Upload sendiri'), 'pilihan unggah background sendiri masih ada');
  assert.ok(!html.includes('theme-grid'), 'kisi pemilih tema masih ada');
  assert.ok(html.includes('tiyanstore-rimuru'), 'kartu Rimuru jadi tema bawaan (di mesin, bukan di UI)');
  assert.ok(html.includes('CORE.THEME.compose'), 'kartu disusun lewat THEME.compose');
});

test('index.html: tema cadangan (offline) identik dengan themes.json', () => {
  const blok = html.match(/\/\* THEME_FALLBACK_START \*\/([\s\S]*?)\/\* THEME_FALLBACK_END \*\//);
  assert.ok(blok, 'blok tema cadangan ditemukan di index.html');
  const fallback = JSON.parse(blok[1].trim());
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'themes', 'themes.json'), 'utf8'));
  const rimuru = meta.themes.find(t => t.id === fallback.id);
  assert.ok(rimuru, 'tema cadangan ada di themes.json: ' + fallback.id);
  assert.deepStrictEqual(fallback, rimuru, 'tema cadangan harus sama persis dengan themes.json');
});
