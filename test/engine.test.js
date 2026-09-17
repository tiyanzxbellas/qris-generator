/* Uji logika inti: PROBE (kenali format), IMG (olah citra), SCAN (rencana), EMV (QRIS) */
const assert = require('assert');
const { test } = require('./t.js');
const { CORE } = require('./helpers.js');

const { PROBE, IMG, SCAN, EMV } = CORE;

/* Payload QRIS statis dari contoh-qris-statis.png (data merchant fiktif) */
const SAMPLE = '00020101021126670012ID.CO.BCA.MI01219881234567890123456780215ID10200299009000303UKE51440014ID.CO.QRIS.WWW0215ID20190000000010303UKE5204599953033605802ID5922WARUNG MAKAN SEDERHANA6007BANDUNG61054012362070703A01630492AE';

const bytes = (...list) => new Uint8Array([].concat(...list.map(x => Array.from(x))));
const asciiBytes = str => new Uint8Array([...str].map(c => c.charCodeAt(0)));

/* ============================ PROBE ============================ */
test('PROBE: mengenali PNG/JPEG/GIF/WebP/BMP', () => {
  assert.strictEqual(PROBE.sniff(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).label, 'PNG');
  assert.strictEqual(PROBE.sniff(bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])).label, 'JPEG');
  assert.strictEqual(PROBE.sniff(asciiBytes('GIF89a......')).label, 'GIF');
  assert.strictEqual(PROBE.sniff(bytes(asciiBytes('RIFF'), [0, 0, 0, 0], asciiBytes('WEBP'))).label, 'WebP');
  assert.strictEqual(PROBE.sniff(asciiBytes('BM......')).label, 'BMP');
  assert.strictEqual(PROBE.sniff(asciiBytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).label, 'SVG');
});

test('PROBE: HEIC/HEIF/AVIF dibaca sebagai keluarga "heif"', () => {
  const box = brand => bytes([0, 0, 0, 0x18], asciiBytes('ftyp'), asciiBytes(brand), [0, 0, 0, 0], asciiBytes('mif1'), asciiBytes(brand));
  const heic = PROBE.sniff(box('heic'));
  assert.strictEqual(heic.family, 'heif');
  assert.strictEqual(heic.label, 'HEIC');
  assert.strictEqual(PROBE.sniff(box('mif1')).family, 'heif');
  assert.strictEqual(PROBE.sniff(box('avif')).label, 'AVIF');
  /* HEIC punya dekoder lokal, AVIF hanya lewat dukungan bawaan browser */
  assert.strictEqual(heic.decoder, 'libheif');
  assert.strictEqual(PROBE.sniff(box('avif')).decoder, '');
  assert.match(PROBE.message(PROBE.sniff(box('avif')), 'decode'), /Ubah dulu ke JPG atau PNG/);
});

test('PROBE: PDF/ZIP/PSD ditandai bukan gambar', () => {
  assert.strictEqual(PROBE.sniff(asciiBytes('%PDF-1.7')).family, 'not-image');
  assert.strictEqual(PROBE.sniff(bytes([0x50, 0x4b, 0x03, 0x04])).family, 'not-image');
  assert.strictEqual(PROBE.sniff(asciiBytes('8BPS')).family, 'not-image');
});

test('PROBE: TIFF/JXL dikenali sebagai format yang belum didukung', () => {
  assert.strictEqual(PROBE.sniff(bytes([0x49, 0x49, 0x2a, 0x00])).label, 'TIFF/RAW');
  assert.strictEqual(PROBE.sniff(bytes([0xff, 0x0a])).label, 'JPEG XL');
});

test('PROBE: berkas kosong dan isi tak dikenal', () => {
  assert.strictEqual(PROBE.sniff(new Uint8Array(0)).family, 'empty');
  assert.strictEqual(PROBE.sniff(bytes([1, 2, 3, 4, 5, 6, 7, 8])).family, 'unknown');
});

test('PROBE: setiap keluarga punya pesan siap tampil', () => {
  ['empty', 'not-image', 'other', 'heif', 'native', 'unknown'].forEach(family => {
    const message = PROBE.message({ family, label: 'X' }, 'decode');
    assert.ok(message.length > 20, family + ' harus punya pesan');
  });
});

test('PROBE.readHead: membaca potongan awal Blob dan menghitung panjang tepat', async () => {
  const blob = new Blob([new Uint8Array(1000).fill(7)]);
  const head = await PROBE.readHead(blob);
  assert.strictEqual(head.length, 64);
  assert.strictEqual(head[0], 7);
  const sniffed = PROBE.sniff(await PROBE.readHead(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])])));
  assert.strictEqual(sniffed.label, 'PNG');
});

/* ============================ IMG ============================ */
function solid(width, height, rgba) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { data, width, height };
}

test('IMG.flatten: transparan menjadi latar putih, gambar buram tidak diubah', () => {
  const transparan = solid(2, 1, [0, 0, 0, 0]);
  const hasil = IMG.flatten(transparan);
  assert.deepStrictEqual([...hasil.data], [255, 255, 255, 255, 255, 255, 255, 255]);

  const buram = solid(2, 1, [0, 0, 0, 255]);
  assert.strictEqual(IMG.flatten(buram), buram, 'gambar buram dikembalikan apa adanya');
});

test('IMG.gray + otsu + binarize: memisahkan gelap dan terang', () => {
  /* 8 piksel: 4 gelap (50) di kiri, 4 terang (200) di kanan */
  const gambar = { data: new Uint8ClampedArray(8 * 4).fill(255), width: 8, height: 1 };
  for (let x = 0; x < 4; x++){
    gambar.data[x * 4] = gambar.data[x * 4 + 1] = gambar.data[x * 4 + 2] = 50;
  }
  for (let x = 4; x < 8; x++){
    gambar.data[x * 4] = gambar.data[x * 4 + 1] = gambar.data[x * 4 + 2] = 200;
  }
  const gray = IMG.gray(gambar);
  assert.strictEqual(gray.data.length, 8);
  assert.strictEqual(gray.data[0], 50);
  assert.strictEqual(gray.data[7], 200);

  const t = IMG.otsu(gray);
  assert.ok(t >= 50 && t < 200, 'ambang di antara gelap dan terang, dapat ' + t);

  const bw = IMG.binarize(gray);
  assert.strictEqual(bw.data[0], 0, 'piksel gelap → hitam');
  assert.strictEqual(bw.data[7], 255, 'piksel terang → putih');
  const rgba = IMG.toRGBA(bw);
  assert.strictEqual(rgba.data.length, 8 * 4);
  assert.strictEqual(rgba.data[3], 255);
});

test('IMG.scale: perkecil memakai rata-rata area', () => {
  /* kotak 2x2: dua hitam (kiri) dan dua putih (kanan) → hasil 1x1 = abu-abu */
  const data = new Uint8ClampedArray([
    0, 0, 0, 255, 255, 255, 255, 255,
    0, 0, 0, 255, 255, 255, 255, 255
  ]);
  const out = IMG.scale({ data, width: 2, height: 2 }, 1, 1);
  assert.strictEqual(out.width, 1);
  assert.ok(out.data[0] > 120 && out.data[0] < 135, 'nilai rata-rata ≈ 127, dapat ' + out.data[0]);
});

test('IMG.scale: perbesar bilinear menjaga dimensi', () => {
  const out = IMG.scale({ data: new Uint8ClampedArray(4 * 4), width: 2, height: 2 }, 6, 9);
  assert.strictEqual(out.width, 6);
  assert.strictEqual(out.height, 9);
  assert.strictEqual(out.data.length, 6 * 9 * 4);
});

test('IMG.fit: hanya mengecilkan bila melebihi batas', () => {
  const kecil = solid(200, 100, [0, 0, 0, 255]);
  assert.strictEqual(IMG.fit(kecil, 800), kecil);
  const besar = IMG.fit(solid(2000, 1000, [0, 0, 0, 255]), 800);
  assert.strictEqual(besar.width, 800);
  assert.strictEqual(besar.height, 400);
});

test('IMG.crop + IMG.tiles: seluruh bidang tercakup', () => {
  const gambar = solid(400, 300, [128, 128, 128, 255]);
  const potong = IMG.crop(gambar, 50, 40, 100, 60);
  assert.deepStrictEqual([potong.width, potong.height], [100, 60]);
  assert.strictEqual(IMG.crop(gambar, 399, 299, 100, 100).width, 1, 'potongan terbatas pada tepi');

  const petak = IMG.tiles(gambar, 3, 3, 0.2);
  assert.strictEqual(petak.length, 9);
  const px = potong.data.length;
  assert.ok(px > 0);
  petak.forEach(p => assert.ok(p.width >= 133 && p.height >= 100, 'petak menutupi bagiannya'));
});

/* ============================ SCAN ============================ */
test('SCAN.buildPlan: gambar kecil tanpa petak, gambar besar berpeta', () => {
  const kecil = SCAN.buildPlan(solid(300, 300, [255, 255, 255, 255]));
  assert.ok(kecil.length >= 4, 'ada beberapa kandidat');
  assert.ok(!kecil.some(s => s.label.includes('petak')), 'gambar kecil tidak perlu dipetak');
  assert.ok(kecil.some(s => s.label.includes('diperbesar')), 'gambar kecil diperbesar');

  const besar = SCAN.buildPlan(solid(2000, 1500, [255, 255, 255, 255]));
  assert.ok(besar.some(s => s.label.includes('petak 2x2')));
  assert.ok(besar.some(s => s.label.includes('petak 3x3')));
  assert.ok(besar.length <= SCAN.MAX_ATTEMPTS, 'jumlah kandidat dibatasi');
});

test('SCAN.buildPlan: kandidat "original" dan "ambang" tidak saling menimpa', () => {
  const plan = SCAN.buildPlan(solid(1000, 800, [255, 255, 255, 255]));
  const labels = plan.map(p => p.label);
  assert.ok(labels.some(l => l.includes('(original)')));
  assert.ok(labels.some(l => l.includes('(ambang)')));
  assert.strictEqual(new Set(labels).size, labels.length, 'label unik');
});

/* ============================ EMV ============================ */
test('EMV.crc16: cocok dengan CRC pada contoh QRIS statis', () => {
  const isi = SAMPLE.slice(0, -4);
  assert.strictEqual(EMV.crc16(isi), SAMPLE.slice(-4));
});

test('EMV.parseTLV + buildTLV: bolak-balik tetap sama', () => {
  const fields = EMV.parseTLV(SAMPLE);
  assert.ok(fields.length > 5);
  assert.strictEqual(fields[0].id, '00');
  assert.strictEqual(fields[fields.length - 1].id, '63');
  assert.strictEqual(EMV.buildTLV(fields), SAMPLE);
});

test('EMV.parseTLV: menolak TLV yang rusak', () => {
  assert.throws(() => EMV.parseTLV('ZZ01'), /TLV rusak/);
  assert.throws(() => EMV.parseTLV('0010AB'), /panjang field/);
});

test('EMV.makeDynamic: tag 01 → 12, nominal disisipkan, CRC dihitung ulang', () => {
  const built = EMV.makeDynamic(SAMPLE, '15000');
  const fields = EMV.parseTLV(built.qrisString);
  const map = {};
  fields.forEach(f => { map[f.id] = f.value; });

  assert.strictEqual(map['01'], '12', 'menjadi QRIS dinamis');
  assert.strictEqual(map['54'], '15000', 'nominal masuk');
  assert.strictEqual(map['59'], 'WARUNG MAKAN SEDERHANA');
  assert.strictEqual(map['60'], 'BANDUNG');
  assert.strictEqual(built.merchantName, 'WARUNG MAKAN SEDERHANA');
  assert.strictEqual(built.merchantCity, 'BANDUNG');
  assert.strictEqual(map['63'], EMV.crc16(built.qrisString.slice(0, -4)), 'CRC valid');
  assert.strictEqual(fields[fields.length - 1].id, '63', 'CRC selalu terakhir');
  const ids = fields.map(f => parseInt(f.id, 10));
  assert.deepStrictEqual(ids.slice(), ids.slice().sort((a, b) => a - b), 'urutan tag menaik');
});

test('EMV.makeDynamic: nominal lama diganti, bukan ditambah', () => {
  const dinamis = EMV.makeDynamic(SAMPLE, '1000').qrisString;
  const lagi = EMV.makeDynamic(dinamis, '7500');
  const fields = EMV.parseTLV(lagi.qrisString);
  assert.strictEqual(fields.filter(f => f.id === '54').length, 1);
  assert.strictEqual(fields.find(f => f.id === '54').value, '7500');
  assert.strictEqual(fields.filter(f => f.id === '63').length, 1);
});

test('EMV.makeDynamic: tag 55 (tip) dibuang bila nominal ditetapkan', () => {
  const fields = EMV.parseTLV(SAMPLE);
  fields.push({ id: '55', value: '01' });
  const statis = EMV.buildTLV(fields);
  const built = EMV.makeDynamic(statis, '2000');
  const hasil = EMV.parseTLV(built.qrisString);
  assert.ok(!hasil.some(f => f.id === '55'), 'tag 55 hilang');
  assert.strictEqual(hasil.find(f => f.id === '54').value, '2000');
});

test('EMV.makeDynamic: panjang field dihitung dalam byte untuk nama UTF-8', () => {
  const fields = [
    { id: '00', value: '01' },
    { id: '01', value: '11' },
    { id: '53', value: '360' },
    { id: '58', value: 'ID' },
    { id: '59', value: 'KAFÉ MÜNCHEN' },
    { id: '60', value: 'JAKARTA' }
  ];
  const statis = EMV.buildTLV(fields);
  const built = EMV.makeDynamic(statis, '5000');
  const ulang = EMV.parseTLV(built.qrisString);          /* gagal bila panjang salah */
  assert.strictEqual(ulang.find(f => f.id === '59').value, 'KAFÉ MÜNCHEN');
  assert.strictEqual(EMV.crc16(built.qrisString.slice(0, -4)), built.qrisString.slice(-4), 'CRC atas byte UTF-8');
});

test('EMV.makeDynamic: menolak payload yang bukan QRIS', () => {
  assert.throws(() => EMV.makeDynamic('HALO DUNIA', '1000'), /TLV rusak/);
  assert.throws(() => EMV.makeDynamic('', '1000'), /kosong/);
  assert.throws(() => EMV.makeDynamic(SAMPLE, 'seribu'), /Nominal tidak valid/);
  assert.throws(() => EMV.makeDynamic(SAMPLE, '12.5'), /Nominal tidak valid/);

  /* tag 00 harus "01" */
  const bukanEmv = EMV.buildTLV([{ id: '00', value: '02' }, { id: '59', value: 'TOKO' }]);
  assert.throws(() => EMV.makeDynamic(bukanEmv, '1000'), /bukan kode pembayaran/);

  /* tanpa tag 59 (nama merchant) */
  const tanpaNama = EMV.buildTLV([{ id: '00', value: '01' }, { id: '53', value: '360' }]);
  assert.throws(() => EMV.makeDynamic(tanpaNama, '1000'), /tag 59 hilang/);
});

/* ============================ RENDER ============================ */
test('RENDER.matrix: ukuran modul wajar untuk payload QRIS', () => {
  const matrix = CORE.RENDER.matrix(SAMPLE);
  assert.ok(matrix.count >= 21 && matrix.count <= 100, 'jumlah modul = ' + matrix.count);
  assert.strictEqual((matrix.count - 17) % 4, 0, 'ukuran modul QR valid (17 + 4×versi)');
  assert.strictEqual(typeof matrix.isDark(0, 0), 'boolean');
});

/* ============================ THEME ============================ */
const { THEME } = CORE;

test('THEME.formatAmount: format Rupiah Indonesia', () => {
  assert.strictEqual(THEME.formatAmount('15000'), 'Rp 15.000');
  assert.strictEqual(THEME.formatAmount('1000', ''), '1.000');
  assert.strictEqual(THEME.formatAmount(0), 'Rp 0');
});

test('THEME.layoutForCustom: posisi center/left/right menghasilkan kotak QR di dalam kanvas', () => {
  ['center', 'left', 'right'].forEach(pos => {
    const layout = THEME.layoutForCustom(1080, 1920, pos);
    assert.ok(layout.qr.size > 100, pos + ' size');
    assert.ok(layout.qr.x >= 0 && layout.qr.y >= 0, pos + ' origin');
    assert.ok(layout.qr.x + layout.qr.size <= 1080, pos + ' muat horizontal');
    assert.ok(layout.qr.y + layout.qr.size <= 1920, pos + ' muat vertikal');
    assert.ok(layout.nominal.y > layout.qr.y, pos + ' nominal di bawah QR');
  });
  const left = THEME.layoutForCustom(1000, 1000, 'left');
  const right = THEME.layoutForCustom(1000, 1000, 'right');
  assert.ok(left.qr.x < right.qr.x, 'left lebih kiri dari right');
});

test('THEME.stackText: urutan nominal → toko → kota tidak bertumpuk', () => {
  const fs = require('fs');
  const path = require('path');
  const meta = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'assets', 'themes', 'themes.json'), 'utf8'
  ));
  const theme = meta.themes.find(t => t.id === 'tiyanstore-rimuru');
  const baris = THEME.stackText([theme.nominal, theme.merchant.name, theme.merchant.city], theme.height);

  assert.ok(baris[0].y < baris[1].y && baris[1].y < baris[2].y,
    'urutan turun: nominal < toko < kota (' + baris.map(b => b.y).join(', ') + ')');
  for (let i = 0; i < 2; i++) {
    const bawah = baris[i].y + THEME.lineHalf(baris[i]);
    const atas = baris[i + 1].y - THEME.lineHalf(baris[i + 1]);
    assert.ok(atas > bawah,
      'baris ke-' + (i + 2) + ' sudah mulai setelah baris ke-' + (i + 1) + ' selesai (' + atas + ' > ' + bawah + ')');
  }
  assert.ok(baris[2].y + THEME.lineHalf(baris[2]) <= theme.height, 'kota masih di dalam kanvas');
  assert.strictEqual(theme.nominal.y, baris[0].y, 'themes.json sudah rapi: posisi nominal tidak digeser');
  /* spec asli tidak boleh diubah oleh stackText */
  const asli = JSON.parse(JSON.stringify(theme));
  THEME.stackText([theme.nominal, theme.merchant.name, theme.merchant.city], 400);
  assert.deepStrictEqual(theme, asli, 'stackText mengembalikan salinan, bukan mengubah tema');
});

test('THEME.stackText: baris yang saling menimpa didorong turun, sejajar rapi', () => {
  /* nominal besar (fs 46) + toko tepat di bawahnya (jarak 5 px) → harus didorong */
  const baris = THEME.stackText([
    { fontSize: 46, y: 910 },
    { fontSize: 24, y: 915 },
    { fontSize: 18, y: 1005 },
  ], 1086);
  const bawah0 = baris[0].y + THEME.lineHalf(baris[0]);
  const atas1 = baris[1].y - THEME.lineHalf(baris[1]);
  assert.ok(baris[0].y === 910, 'baris teratas tetap di tempatnya');
  assert.ok(baris[1].y > 915, 'baris toko didorong turun dari y 915 → ' + baris[1].y);
  assert.ok(atas1 > bawah0, 'toko mulai setelah nominal selesai (' + atas1 + ' > ' + bawah0 + ')');
  assert.ok(baris[2].y >= baris[1].y + THEME.lineHalf(baris[1]) + THEME.lineHalf(baris[2]),
    'kota tetap di bawah toko');
});

test('THEME.stackText: blok teks yang melewati batas bawah kanvas digeser ke atas', () => {
  const half = spec => THEME.lineHalf(spec);
  const baris = THEME.stackText([
    { fontSize: 30, y: 500 },
    { fontSize: 20, y: 560 },
    { fontSize: 16, y: 590 },
  ], 600);
  assert.ok(baris[2].y + half(baris[2]) <= 600, 'baris terakhir masuk kanvas');
  assert.ok(baris[0].y - half(baris[0]) > 0, 'nominal tidak sampai keluar dari sisi atas');
  assert.ok(baris[0].y < baris[1].y && baris[1].y < baris[2].y, 'urutan tetap nominal → toko → kota');
});

test('THEME.layoutForCustom: QR + seluruh blok teks muat di kanvas', () => {
  const half = spec => THEME.lineHalf(spec);
  [[1080, 1920, 'center'], [1000, 1000, 'left'], [1600, 900, 'right']].forEach(([w, h, pos]) => {
    const layout = THEME.layoutForCustom(w, h, pos);
    const merchant = THEME.merchantLayoutForCustom(w, h, layout.nominal);
    const bawahQR = layout.qr.y + layout.qr.size;
    assert.ok(layout.nominal.y - half(layout.nominal) > bawahQR,
      pos + ': nominal mulai di bawah QR');
    assert.ok(merchant.name.y - half(merchant.name) > layout.nominal.y + half(layout.nominal),
      pos + ': nama toko mulai di bawah nominal');
    assert.ok(merchant.city.y - half(merchant.city) > merchant.name.y + half(merchant.name),
      pos + ': kota mulai di bawah nama toko');
    assert.ok(merchant.city.y + half(merchant.city) <= h, pos + ': kota tidak melewati dasar kanvas');
    assert.ok(layout.nominal.fontSize > merchant.name.fontSize && merchant.name.fontSize > merchant.city.fontSize,
      pos + ': nominal paling besar, lalu toko, lalu kota');
  });
});

test('THEME.compose: tema polos/tanpa background ditolak, bukan diam-diam jadi QR polos', () => {
  const built = EMV.makeDynamic(SAMPLE, '25000');
  const { createCanvas } = require('./helpers.js');
  const create = () => createCanvas(16, 16);

  assert.throws(
    () => THEME.compose({ text: built.qrisString, createCanvas: create }),
    /bergambar/,
    'tanpa tema harus gagal'
  );
  assert.throws(
    () => THEME.compose({ text: built.qrisString, theme: { type: 'plain' }, createCanvas: create }),
    /bergambar/,
    'tema polos lama harus gagal'
  );
  assert.throws(
    () => THEME.compose({ text: built.qrisString, theme: { type: 'image' }, createCanvas: create }),
    /Gambar tema belum dimuat/,
    'tema gambar tanpa background harus gagal'
  );
});

test('THEME.compose: layout kartu Rimuru (themes.json) pas di kanvas', () => {
  const fs = require('fs');
  const path = require('path');
  const { createCanvas, canvasToImageData } = require('./helpers.js');
  const meta = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'assets', 'themes', 'themes.json'), 'utf8'
  ));
  const theme = meta.themes.find(t => t.id === 'tiyanstore-rimuru');
  assert.ok(theme, 'entri tiyanstore-rimuru ada di katalog');

  /* background palsu seukuran tema */
  const bgCanvas = createCanvas(theme.width, theme.height);
  const bgCtx = bgCanvas.getContext('2d');
  bgCtx.fillStyle = '#123456';
  bgCtx.fillRect(0, 0, theme.width, theme.height);
  const bg = Object.assign({
    width: theme.width, height: theme.height,
    naturalWidth: theme.width, naturalHeight: theme.height,
  }, bgCanvas);

  const built = EMV.makeDynamic(SAMPLE, '17500');
  const dataUrl = THEME.compose({
    text: built.qrisString,
    theme,
    background: bg,
    amount: '17500',
    merchantName: built.merchantName,
    merchantCity: built.merchantCity,
    createCanvas,
  });

  const out = canvasToImageData(dataUrl);
  assert.strictEqual(out.width, theme.width, 'lebar kartu');
  assert.strictEqual(out.height, theme.height, 'tinggi kartu');

  /* slot QR harus berisi modul hitam-putih, bukan background gelap */
  const q = theme.qr;
  let dark = 0, light = 0, total = 0;
  for (let y = q.y + 12; y < q.y + q.size - 12; y += 3) {
    for (let x = q.x + 12; x < q.x + q.size - 12; x += 3) {
      const i = (y * theme.width + x) * 4;
      const l = (out.data[i] + out.data[i + 1] + out.data[i + 2]) / 3;
      total++;
      if (l < 40) dark++;
      if (l > 220) light++;
    }
  }
  assert.ok(dark / total > 0.1, 'modul hitam ada di slot, dark=' + (dark / total).toFixed(2));
  assert.ok(light / total > 0.1, 'latar putih ada di slot, light=' + (light / total).toFixed(2));
});

test('THEME.compose image: menempel QR + nominal ke background', () => {
  const { createCanvas, canvasToImageData } = require('./helpers.js');
  const built = EMV.makeDynamic(SAMPLE, '50000');
  const W = 400, H = 500;
  /* background palsu: solid gelap */
  const bgCanvas = createCanvas(W, H);
  const bgCtx = bgCanvas.getContext('2d');
  bgCtx.fillStyle = '#102030';
  bgCtx.fillRect(0, 0, W, H);
  const bg = {
    width: W, height: H, naturalWidth: W, naturalHeight: H,
    /* drawImage di Node mock menerima objek {width,height,_data?} — helpers handle canvas source */
  };
  /* helpers createCanvas returns object usable as source via our mock drawImage */
  Object.assign(bg, bgCanvas);

  const theme = {
    type: 'image', width: W, height: H,
    qr: { x: 50, y: 40, size: 220, padding: 10, radius: 0 },
    nominal: {
      x: 160, y: 300, align: 'center', maxWidth: 300,
      fontSize: 28, color: '#FFFFFF', prefix: 'Rp ', shadow: false,
    },
  };
  const dataUrl = THEME.compose({
    text: built.qrisString,
    theme,
    background: bg,
    amount: '50000',
    createCanvas,
  });
  assert.ok(dataUrl.startsWith('data:image/png'));
  /* decode hasil: area QR harus banyak hitam-putih (kontras), bukan solid gelap */
  const out = canvasToImageData(dataUrl);
  assert.ok(out.width === W && out.height === H);
  let dark = 0, light = 0, total = 0;
  for (let y = 50; y < 250; y += 2) {
    for (let x = 60; x < 260; x += 2) {
      const i = (y * W + x) * 4;
      const l = (out.data[i] + out.data[i + 1] + out.data[i + 2]) / 3;
      total++;
      if (l < 40) dark++;
      if (l > 220) light++;
    }
  }
  assert.ok(dark / total > 0.15, 'modul hitam QR ada di slot, dark=' + (dark / total).toFixed(2));
  assert.ok(light / total > 0.15, 'latar putih QR ada di slot, light=' + (light / total).toFixed(2));
});

/* ============================ BYTES ============================ */
const { BYTES } = CORE;

test('BYTES: berkas yang sudah bersih tidak diutak-atik', () => {
  const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], asciiBytes('IEND'), [0, 0, 0, 0]);
  assert.deepStrictEqual(BYTES.rescueCandidates(png), [], 'PNG utuh: tidak ada yang perlu diperbaiki');
  assert.strictEqual(BYTES.rescue(png), null);
  assert.deepStrictEqual(BYTES.rescueCandidates(new Uint8Array(0)), [], 'berkas kosong: tidak ada kandidat');
});

test('BYTES: sampah di awal berkas dibuang sampai tanda tangan format', () => {
  const jpegUtuh = bytes([0xff, 0xd8, 0xff, 0xe0], new Uint8Array(20).fill(1), [0xff, 0xd9]);
  const kotor = bytes(asciiBytes('HTTP/1.1 200 OK\r\n\r\n'), jpegUtuh);
  const hasil = BYTES.rescue(kotor);
  assert.ok(hasil, 'ada perbaikan');
  assert.deepStrictEqual(Array.from(hasil.bytes), Array.from(jpegUtuh));
  assert.match(hasil.actions.join(' '), /awal berkas dibuang/);
});

test('BYTES: sampah setelah akhir JPEG/PNG dibuang', () => {
  const jpegUtuh = bytes([0xff, 0xd8, 0xff, 0xe0], new Uint8Array(10).fill(2), [0xff, 0xd9]);
  const jpg = BYTES.rescue(bytes(jpegUtuh, asciiBytes('SAMPAH')));
  assert.deepStrictEqual(Array.from(jpg.bytes), Array.from(jpegUtuh));

  const pngUtuh = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], asciiBytes('IEND'), [1, 2, 3, 4]);
  const png = BYTES.rescue(bytes(pngUtuh, asciiBytes('XX')));
  assert.deepStrictEqual(Array.from(png.bytes), Array.from(pngUtuh));
  assert.match(png.actions.join(' '), /akhir PNG dibuang/);
});

test('BYTES: JPEG tanpa penanda akhir ditambal beberapa ukuran, urut dari kecil', () => {
  const terpotong = bytes([0xff, 0xd8, 0xff, 0xe0], new Uint8Array(40).fill(3));
  const kandidat = BYTES.rescueCandidates(terpotong);
  assert.ok(kandidat.length >= 2, 'ada beberapa kandidat tambalan, dapat ' + kandidat.length);
  kandidat.forEach(c => {
    assert.strictEqual(c.bytes[c.bytes.length - 2], 0xff, 'ditutup FFD9');
    assert.strictEqual(c.bytes[c.bytes.length - 1], 0xd9);
    assert.match(c.actions.join(' '), /terpotong/);
  });
  for (let i = 1; i < kandidat.length; i++) {
    assert.ok(kandidat[i].bytes.length > kandidat[i - 1].bytes.length, 'tambalan makin besar');
  }
});

test('BYTES: penanda FF separuh di ujung berkas terpotong tidak ikut terbawa', () => {
  const terpotong = bytes([0xff, 0xd8, 0xff, 0xe0], new Uint8Array(10).fill(4), [0xff, 0xff]);
  const c = BYTES.rescueCandidates(terpotong)[0];
  assert.strictEqual(c.bytes[14], 0, 'byte FF menggantung sudah dipotong, diganti bantalan 0');
});

test('BYTES: isi berupa data URL / base64 didekode jadi biner aslinya', () => {
  const asli = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], asciiBytes('IHDRdata'), asciiBytes('IEND'), [0, 0, 0, 0]);
  const b64 = Buffer.from(asli).toString('base64');

  const dariDataUrl = BYTES.rescue(asciiBytes('data:image/png;base64,' + b64));
  assert.ok(dariDataUrl, 'data URL dikenali');
  assert.deepStrictEqual(Array.from(dariDataUrl.bytes), Array.from(asli));
  assert.match(dariDataUrl.actions.join(' '), /base64/);

  const dariBase64Polos = BYTES.rescue(asciiBytes(b64));
  assert.deepStrictEqual(Array.from(dariBase64Polos.bytes), Array.from(asli));
});

test('BYTES: teks biasa bukan base64 tidak dipaksa didekode', () => {
  assert.strictEqual(BYTES.fromBase64Text(asciiBytes('halo ini catatan biasa, bukan gambar sama sekali!!')), null);
});

test('BYTES.readErrorMessage: gagal baca karena izin dijelaskan sebagai masalah izin', () => {
  const err = new Error('The requested file could not be read, typically due to permission problems');
  err.name = 'NotReadableError';
  const pesan = BYTES.readErrorMessage(err);
  assert.match(pesan, /izin/i);
  assert.match(pesan, /[Pp]ilih ulang/);
  assert.ok(!/format/i.test(pesan), 'jangan menyalahkan format gambar');

  const hilang = new Error('file not found');
  hilang.name = 'NotFoundError';
  assert.match(BYTES.readErrorMessage(hilang), /sudah tidak ada|dipindah/);

  assert.ok(BYTES.readErrorMessage(new Error('entah')).length > 20, 'selalu ada pesan');
});

test('PROBE.message: berkas PNG/JPG tak terbaca disebut tidak utuh, bukan "format tidak didukung"', () => {
  const pesan = PROBE.message({ family: 'native', label: 'JPEG' }, 'decode');
  assert.match(pesan, /tidak utuh|terpotong/);
  assert.match(pesan, /screenshot|tangkapan layar|ulang/);
});
