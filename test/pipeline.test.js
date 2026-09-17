/* Uji alur nyata: gambar (PNG/JPEG/HEIC/AVIF/…) → pindai QR → QRIS dinamis → gambar ulang */
const assert = require('assert');
const { test } = require('./t.js');
const h = require('./helpers.js');

const { CORE, readFixture, readPng, readJpeg, readHeif, readThemeImage, matrixToImage, scan, createCanvas, canvasToImageData } = h;

/* Background & logo tema → objek ala ImageData yang dipahami mock canvas */
function muatAsetTema(theme) {
  const path = require('path');
  const bg = readThemeImage(path.join(h.ROOT, 'assets', 'themes', theme.image));
  const background = Object.assign({
    width: bg.width, height: bg.height,
    naturalWidth: bg.width, naturalHeight: bg.height,
    data: bg.data,
  }, { _data: bg.data });
  let logo;
  if (theme.qr && theme.qr.logo && theme.qr.logo.image) {
    const lg = readThemeImage(path.join(h.ROOT, 'assets', 'themes', theme.qr.logo.image));
    logo = Object.assign({
      width: lg.width, height: lg.height,
      naturalWidth: lg.width, naturalHeight: lg.height,
    }, { _data: lg.data });
  }
  return { background, logo };
}
const SAMPLE = '00020101021126670012ID.CO.BCA.MI01219881234567890123456780215ID10200299009000303UKE51440014ID.CO.QRIS.WWW0215ID20190000000010303UKE5204599953033605802ID5922WARUNG MAKAN SEDERHANA6007BANDUNG61054012362070703A01630492AE';

test('PNG contoh (690×690): payload QRIS terbaca', async () => {
  const hasil = await scan(readPng(h.ROOT + '/contoh-qris-statis.png'));
  assert.strictEqual(hasil.data, SAMPLE);
  assert.ok(hasil.attempts <= 3, 'terbaca cepat, percobaan = ' + hasil.attempts);
});

test('HEIC (foto iPhone): didekode dekoder lokal lalu QRIS terbaca', async () => {
  /* jalur yang sama dengan IMAGELOAD di halaman: vendor/libheif-bundle.js */
  const image = await readHeif('qris.heic');
  assert.deepStrictEqual([image.width, image.height], [690, 690]);
  const hasil = await scan(image);
  assert.strictEqual(hasil.data, SAMPLE);
});

test('AVIF: dikenali benar; wasm libheif tanpa AV1 sehingga pesannya jujur', async () => {
  /* Build libheif wasm hanya memuat dekoder HEVC (HEIC), bukan AV1 (AVIF) —
     AVIF mengandalkan dukungan bawaan browser (Chrome/Firefox/Safari baru). */
  const info = CORE.PROBE.sniff(new Uint8Array(require('fs').readFileSync(
    require('path').join(h.FIXTURES, 'qris.avif')
  ).slice(0, 32)));
  assert.strictEqual(info.label, 'AVIF');
  assert.strictEqual(info.decoder, '');
  assert.match(CORE.PROBE.message(info, 'decode'), /Ubah dulu ke JPG atau PNG/);

  /* dan libheif (dipakai Node untuk HEIC) memang tidak bisa mendekode AVIF */
  const consoleError = console.error;
  console.error = () => {};   /* wasm mencetak peringatan ke stderr */
  try {
    await assert.rejects(
      async () => { const image = await readHeif('qris.avif'); await scan(image); },
      /Dekode HEIF gagal/
    );
  } finally {
    console.error = consoleError;
  }
});

test('JPEG terkompresi berat (q=30): masih terbaca', async () => {
  const hasil = await scan(readFixture('qris-jpeg-berat.jpg'));
  assert.strictEqual(hasil.data, SAMPLE);
});

test('QR kecil (240 px): terbaca lewat jalur perbesaran', async () => {
  const image = readPng(h.FIXTURES + '/qris-kecil.png');
  assert.strictEqual(image.width, 240);
  const hasil = await scan(image);
  assert.strictEqual(hasil.data, SAMPLE);
});

test('PNG berlatar transparan: diratakan ke latar putih dulu', async () => {
  const hasil = await scan(readPng(h.FIXTURES + '/qris-transparan.png'));
  assert.strictEqual(hasil.data, SAMPLE);
});

test('QR terbalik (terang di atas gelap): terbaca', async () => {
  const hasil = await scan(readPng(h.FIXTURES + '/qris-terbalik.png'));
  assert.strictEqual(hasil.data, SAMPLE);
});

test('Foto besar 1600×1200 dengan QR kecil di sudut: terbaca lewat pemetakan', async () => {
  const image = readFixture('foto-qris.jpg');
  const hasil = await scan(image);
  assert.strictEqual(hasil.data, SAMPLE);
});

test('Hasil generate bisa dipindai ulang (round-trip QR)', () => {
  const built = CORE.EMV.makeDynamic(SAMPLE, '25000');
  const matrix = CORE.RENDER.matrix(built.qrisString);
  const image = matrixToImage(matrix);
  const code = global.jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
  assert.ok(code, 'QR hasil generate terbaca kembali');
  assert.strictEqual(code.data, built.qrisString);
});

test('Kartu Rimuru (tema bawaan): QR + nominal ditempel, kartu tetap terbaca', async () => {
  const fs = require('fs');
  const path = require('path');
  const meta = JSON.parse(fs.readFileSync(
    path.join(h.ROOT, 'assets', 'themes', 'themes.json'), 'utf8'
  ));
  const theme = meta.themes.find(t => t.id === 'tiyanstore-rimuru');
  assert.ok(theme, 'kartu Rimuru ada di katalog');

  /* background + logo tengah asli dari berkas tema (jalur yang sama dengan halaman) */
  const aset = muatAsetTema(theme);
  const built = CORE.EMV.makeDynamic(SAMPLE, '75000');
  const dataUrl = CORE.THEME.compose({
    text: built.qrisString,
    theme,
    background: aset.background,
    logo: aset.logo,
    amount: '75000',
    merchantName: built.merchantName,
    merchantCity: built.merchantCity,
    createCanvas,
  });

  const kartu = canvasToImageData(dataUrl);
  assert.strictEqual(kartu.width, theme.width, 'kartu seukuran background');
  assert.strictEqual(kartu.height, theme.height);

  const hasil = await scan(kartu);
  assert.ok(hasil.data, 'QR pada kartu masih terbaca');
  assert.strictEqual(hasil.data, built.qrisString, 'payload dinamis utuh di kartu');
});

/* Batas bawah label "NOMINAL" pada gambar kartu: baris terakhir yang masih
   punya garis/teks terang di kolom kiri (ikon + tulisan + bar birunya). */
function bawahLabelNominal(gambar) {
  let bawah = 0;
  for (let y = Math.round(gambar.height * 0.7); y < Math.round(gambar.height * 0.95); y++) {
    let terang = 0;
    for (let x = 60; x < 340; x++) {
      const i = (y * gambar.width + x) * 4;
      const l = 0.299 * gambar.data[i] + 0.587 * gambar.data[i + 1] + 0.114 * gambar.data[i + 2];
      if (l > 120) terang++;
    }
    if (terang > 60) bawah = y;
  }
  return bawah;
}

test('Kartu Rimuru: nominal tepat di bawah label NOMINAL, lalu toko, lalu kota', async () => {
  const fs = require('fs');
  const path = require('path');
  const meta = JSON.parse(fs.readFileSync(
    path.join(h.ROOT, 'assets', 'themes', 'themes.json'), 'utf8'
  ));
  const theme = meta.themes.find(t => t.id === 'tiyanstore-rimuru');
  const aset = muatAsetTema(theme);
  const bg = aset.background;
  const built = CORE.EMV.makeDynamic(SAMPLE, '75000');

  let kanvas = null;
  const dataUrl = CORE.THEME.compose({
    text: built.qrisString,
    theme,
    background: bg,
    logo: aset.logo,
    amount: '75000',
    merchantName: built.merchantName,
    merchantCity: built.merchantCity,
    createCanvas: (w, h) => (kanvas = createCanvas(w || 16, h || 16)),
  });

  const rekam = kanvas._texts || [];
  const ambil = t => rekam.filter(x => x.text === t)[0];
  const nominal = ambil('Rp 75.000');
  const toko = ambil('WARUNG MAKAN SEDERHANA');
  const kota = ambil('BANDUNG');
  assert.ok(nominal && toko && kota,
    'nominal, nama toko, dan kota semuanya digambar: ' + rekam.map(t => t.text).join(' | '));

  const label = bawahLabelNominal(bg);
  assert.ok(label > 800, 'label NOMINAL terdeteksi di gambar kartu (baris ' + label + ')');
  assert.ok(nominal.y0 > label,
    'baris nominal mulai DI BAWAH label NOMINAL (y ' + nominal.y0 + ' > ' + label + ')');
  assert.ok(toko.y0 >= nominal.y1, 'nama toko mulai setelah baris nominal selesai');
  assert.ok(kota.y0 >= toko.y1, 'kota mulai setelah baris nama toko selesai');
  assert.ok(kota.y1 <= theme.height, 'kota masih di dalam kartu');

  /* tinta baris-baris itu benar-benar tergambar di kartu (bukan cuma dihitung) */
  const kartu = canvasToImageData(dataUrl);
  [['nominal', nominal], ['toko', toko], ['kota', kota]].forEach(([nama, baris]) => {
    let terang = 0, total = 0;
    for (let y = Math.ceil(baris.y - baris.fontSize / 2); y < Math.ceil(baris.y + baris.fontSize / 2); y++) {
      for (let x = Math.ceil(baris.x0); x < Math.ceil(baris.x1); x++) {
        if (y < 0 || y >= kartu.height || x < 0 || x >= kartu.width) continue;
        const i = (y * kartu.width + x) * 4;
        total++;
        if (kartu.data[i] > 200 || kartu.data[i + 1] > 200 || kartu.data[i + 2] > 200) terang++;
      }
    }
    assert.ok(terang / total > 0.05, 'baris ' + nama + ' punya piksel teks (' + (terang / total * 100).toFixed(1) + '%)');
  });

  /* dan QR-nya tetap terbaca */
  const hasil = await scan(kartu);
  assert.strictEqual(hasil.data, built.qrisString, 'payload dinamis utuh di kartu');
});

test('Background unggahan sendiri: nominal → toko → kota tersusun di dalam kanvas', async () => {
  const W = 1200, H = 900;
  const bgCanvas = createCanvas(W, H);
  const bgCtx = bgCanvas.getContext('2d');
  bgCtx.fillStyle = '#101c2c';
  bgCtx.fillRect(0, 0, W, H);
  const bg = Object.assign({
    width: W, height: H, naturalWidth: W, naturalHeight: H,
  }, bgCanvas);

  const built = CORE.EMV.makeDynamic(SAMPLE, '15000');
  const theme = { id: 'custom', type: 'custom', position: 'left' };
  let kanvas = null;
  const dataUrl = CORE.THEME.compose({
    text: built.qrisString,
    theme,
    background: bg,
    amount: '15000',
    merchantName: built.merchantName,
    merchantCity: built.merchantCity,
    createCanvas: (w, h) => (kanvas = createCanvas(w || 16, h || 16)),
  });
  assert.ok(dataUrl.startsWith('data:image/png'));

  const rekam = kanvas._texts || [];
  const nominal = rekam.filter(x => x.text === 'Rp 15.000')[0];
  const toko = rekam.filter(x => x.text === 'WARUNG MAKAN SEDERHANA')[0];
  const kota = rekam.filter(x => x.text === 'BANDUNG')[0];
  assert.ok(nominal && toko && kota, 'ketiga baris teks digambar');

  const layout = CORE.THEME.layoutForCustom(W, H, 'left');
  assert.ok(nominal.y > layout.qr.y + layout.qr.size, 'nominal di bawah QR');
  assert.ok(nominal.y0 > layout.qr.y + layout.qr.size, 'baris nominal tidak menimpa QR');
  assert.ok(toko.y0 >= nominal.y1, 'toko di bawah nominal');
  assert.ok(kota.y0 >= toko.y1, 'kota di bawah toko');
  assert.ok(kota.y1 <= H, 'kota masih di dalam kanvas');
  assert.ok(nominal.x0 >= 0 && nominal.x1 <= W && toko.x1 <= W && kota.x1 <= W,
    'semua baris teks berada di dalam lebar kanvas');

  const kartu = canvasToImageData(dataUrl);
  let terang = 0, total = 0;
  for (let y = Math.ceil(toko.y0); y < Math.ceil(toko.y1); y++) {
    for (let x = Math.ceil(toko.x0); x < Math.ceil(toko.x1); x++) {
      const i = (y * W + x) * 4;
      total++;
      if (kartu.data[i] > 200 && kartu.data[i + 1] > 200 && kartu.data[i + 2] > 200) terang++;
    }
  }
  assert.ok(terang / total > 0.05, 'baris toko punya piksel teks (' + (terang / total * 100).toFixed(1) + '%)');
});

test('Alur lengkap: gambar → nominal → string QRIS dinamis yang valid', async () => {
  const hasil = await scan(readPng(h.ROOT + '/contoh-qris-statis.png'));
  const built = CORE.EMV.makeDynamic(hasil.data, '99000');
  const fields = CORE.EMV.parseTLV(built.qrisString);
  const map = {};
  fields.forEach(f => { map[f.id] = f.value; });
  assert.strictEqual(map['01'], '12');
  assert.strictEqual(map['54'], '99000');
  assert.strictEqual(map['63'], CORE.EMV.crc16(built.qrisString.slice(0, -4)));
  assert.strictEqual(built.merchantName, 'WARUNG MAKAN SEDERHANA');

  /* dan QR baru memang terbaca sebagai payload tersebut */
  const image = matrixToImage(CORE.RENDER.matrix(built.qrisString));
  const ulang = global.jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
  assert.strictEqual(ulang.data, built.qrisString);
});

test('Gambar tanpa QR: pemindaian selesai tanpa hasil, tanpa lempar kesalahan', async () => {
  const kosong = { data: new Uint8ClampedArray(400 * 300 * 4).fill(255), width: 400, height: 300 };
  const hasil = await scan(kosong);
  assert.strictEqual(hasil.data, null);
  assert.ok(hasil.attempts >= 1);
});

test('Gambar tanpa QR: upaya pemindaian tetap terbatas', async () => {
  const kosong = { data: new Uint8ClampedArray(1800 * 1300 * 4).fill(255), width: 1800, height: 1300 };
  const mulai = Date.now();
  const hasil = await scan(kosong);
  const detik = (Date.now() - mulai) / 1000;
  assert.strictEqual(hasil.data, null);
  assert.ok(hasil.attempts <= CORE.SCAN.MAX_ATTEMPTS);
  assert.ok(detik < 20, 'pemindaian selesai dalam waktu wajar (' + detik.toFixed(1) + ' s)');
});

/* ===== berkas "hampir benar": terpotong / disisipi sampah / base64 ===== */
const fs = require('fs');
const jpegjs = require('jpeg-js');

/* Meniru jalur halaman: byte berkas → perbaikan BYTES → dekode → pindai QR */
async function scanBytes(raw, kind) {
  const decode = buf => (kind === 'png'
    ? h.toMasked(require('pngjs').PNG.sync.read(Buffer.from(buf)).data,
                 require('pngjs').PNG.sync.read(Buffer.from(buf)).width,
                 require('pngjs').PNG.sync.read(Buffer.from(buf)).height)
    : (() => { const d = jpegjs.decode(Buffer.from(buf), { useTArray: true, tolerantDecoding: true });
               return h.toMasked(d.data, d.width, d.height); })());

  try { return { hasil: await scan(decode(raw)), perbaikan: null }; } catch (e) { /* perlu diselamatkan */ }

  for (const cand of CORE.BYTES.rescueCandidates(raw)) {
    let image;
    try { image = decode(cand.bytes); } catch (e) { continue; }
    const hasil = await scan(image);
    if (hasil.data) return { hasil, perbaikan: cand.actions };
  }
  return { hasil: { data: null }, perbaikan: null };
}

test('JPEG terpotong (unduhan belum selesai): ditambal lalu QRIS tetap terbaca', async () => {
  const utuh = fs.readFileSync(h.FIXTURES + '/qris-jpeg-berat.jpg');
  const terpotong = new Uint8Array(utuh.subarray(0, Math.floor(utuh.length * 0.97)));

  /* tanpa perbaikan, dekoder memang menolak berkas ini */
  assert.throws(() => jpegjs.decode(Buffer.from(terpotong), { useTArray: true, tolerantDecoding: true }));

  const { hasil, perbaikan } = await scanBytes(terpotong, 'jpg');
  assert.strictEqual(hasil.data, SAMPLE, 'QRIS tetap terbaca dari berkas terpotong');
  assert.match(perbaikan.join(' '), /terpotong/);
});

test('Foto besar yang terpotong: bagian yang sempat tersalin sudah cukup', async () => {
  const utuh = fs.readFileSync(h.FIXTURES + '/foto-qris.jpg');
  const terpotong = new Uint8Array(utuh.subarray(0, Math.floor(utuh.length * 0.9)));
  const { hasil } = await scanBytes(terpotong, 'jpg');
  assert.strictEqual(hasil.data, SAMPLE);
});

test('JPEG dengan sampah di depan (mis. header terbawa): dibersihkan lalu terbaca', async () => {
  const utuh = fs.readFileSync(h.FIXTURES + '/qris-jpeg-berat.jpg');
  const kotor = new Uint8Array(Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\n\r\n'), utuh]));
  const { hasil, perbaikan } = await scanBytes(kotor, 'jpg');
  assert.strictEqual(hasil.data, SAMPLE);
  assert.match(perbaikan.join(' '), /awal berkas/);
});

test('PNG dengan sampah di belakang: dipotong di IEND lalu terbaca', async () => {
  const utuh = fs.readFileSync(h.ROOT + '/contoh-qris-statis.png');
  const kotor = new Uint8Array(Buffer.concat([utuh, Buffer.from('\n\n--sisa kiriman chat--')]));
  const { hasil } = await scanBytes(kotor, 'png');
  assert.strictEqual(hasil.data, SAMPLE);
});

test('Berkas berisi teks base64/data URL: didekode dulu lalu terbaca', async () => {
  const utuh = fs.readFileSync(h.ROOT + '/contoh-qris-statis.png');
  const asText = new Uint8Array(Buffer.from('data:image/png;base64,' + utuh.toString('base64')));
  const { hasil, perbaikan } = await scanBytes(asText, 'png');
  assert.strictEqual(hasil.data, SAMPLE);
  assert.match(perbaikan.join(' '), /base64/);
});
