/* Pemuat bersama untuk pengujian: library vendor + logika inti + pembaca gambar */
const path = require('path');
const fs = require('fs');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');

/* --- library vendor dipasang sebagai global, sama seperti di browser --- */
global.qrcode = require(path.join(ROOT, 'vendor', 'qrcode.min.js'));
require(path.join(ROOT, 'vendor', 'qrcode-utf8.js'));   /* add-on UTF-8 */
global.jsQR = require(path.join(ROOT, 'vendor', 'jsqr.min.js'));

const CORE = require(path.join(ROOT, 'src', 'qris-core.js'));

/* --- pembaca gambar → { data, width, height } seperti ImageData browser --- */
function toMasked(rgbaLike, width, height) {
  return { data: new Uint8ClampedArray(rgbaLike), width, height };
}

function readPng(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  return toMasked(png.data, png.width, png.height);
}

function readJpeg(file) {
  const raw = jpeg.decode(fs.readFileSync(file), { useTArray: true });
  return toMasked(raw.data, raw.width, raw.height);
}

function readFixture(name) {
  const file = path.join(FIXTURES, name);
  if (name.endsWith('.png')) return readPng(file);
  if (name.endsWith('.jpg')) return readJpeg(file);
  throw new Error('Pembaca gambar uji belum ada untuk ' + name);
}

/* --- dekoder HEIC/HEIF/AVIF: memakai berkas vendor yang sama dengan halaman --- */
let heifModulePromise = null;
function heifModule() {
  if (!heifModulePromise) {
    const factory = require(path.join(ROOT, 'vendor', 'libheif-bundle.js'));
    heifModulePromise = Promise.resolve(factory());
  }
  return heifModulePromise;
}

async function readHeif(name) {
  const lib = await heifModule();
  const bytes = new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
  const images = new lib.HeifDecoder().decode(bytes);
  if (!images.length) throw new Error('HEIF tanpa gambar');
  const image = images[0];
  const width = image.get_width(), height = image.get_height();
  const decoded = await new Promise((resolve, reject) => {
    image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, data => {
      if (data) resolve(data); else reject(new Error('Dekode HEIF gagal'));
    });
  });
  return { data: decoded.data, width, height };
}

/* --- konversi matriks QR hasil RENDER.matrix → ImageData (untuk uji round-trip) --- */
function matrixToImage(matrix, cell, quiet) {
  cell = cell || 6;
  quiet = quiet === undefined ? 4 : quiet;
  const size = (matrix.count + quiet * 2) * cell;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < matrix.count; r++) {
    for (let c = 0; c < matrix.count; c++) {
      if (!matrix.isDark(r, c)) continue;
      for (let y = (r + quiet) * cell; y < (r + quiet + 1) * cell; y++) {
        for (let x = (c + quiet) * cell; x < (c + quiet + 1) * cell; x++) {
          const i = (y * size + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, width: size, height: size };
}

/* --- pemindaian memakai rencana yang sama dengan halaman --- */
async function scan(imageData) {
  return CORE.SCAN.scan(imageData, {});
}

/* --- parser warna ringkas untuk tinta teks di mock canvas --- */
function parseWarna(c) {
  if (typeof c !== 'string') return [0, 0, 0];
  c = c.trim();
  if (c[0] === '#' && (c.length === 7 || c.length === 4)) {
    if (c.length === 7) {
      return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
    }
    return [parseInt(c[1] + c[1], 16), parseInt(c[2] + c[2], 16), parseInt(c[3] + c[3], 16)];
  }
  const m = c.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (m) return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
  if (/white/i.test(c)) return [255, 255, 255];
  if (/black/i.test(c)) return [0, 0, 0];
  return [0, 0, 0];
}

function tulisPiksel(canvas, x, y, rgb) {
  x = x | 0; y = y | 0;
  const w = canvas.width, h = canvas.height;
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 4;
  canvas._data[i] = rgb[0];
  canvas._data[i + 1] = rgb[1];
  canvas._data[i + 2] = rgb[2];
  canvas._data[i + 3] = 255;
}

/*
  Mock fillText/strokeText: catat posisi & ukuran teks (untuk uji tata letak —
  nominal/toko/kota tidak boleh bertumpuk) lalu gambarkan tinta berupa blok
  per karakter supaya uji piksel tahu baris mana yang benar-benar terisi.
  Lebar teks memakai model yang sama dengan measureText: 0.6 × fontSize/karakter.
*/
function catatDanGambarTeks(ctx, canvas, state, text, x, y) {
  const label = String(text === undefined || text === null ? '' : text);
  const fontPx = parseInt((String(state.font).match(/(\d+)px/) || [0, 16])[1], 10) || 16;
  const weight = /bold|[789]00/.test(String(state.font)) ? '700' : '400';
  const width = label.length * fontPx * 0.6;
  let x0 = x;
  if (state.textAlign === 'center') x0 = x - width / 2;
  else if (state.textAlign === 'right' || state.textAlign === 'end') x0 = x - width;
  /* textBaseline 'middle' pada semua teks kartu → y = titik tengah baris */
  const rec = {
    text: label, x, y, x0, x1: x0 + width,
    y0: y - fontPx / 2, y1: y + fontPx / 2,
    width, fontSize: fontPx, weight,
    fill: state.fillStyle, stroke: state.strokeStyle, align: state.textAlign,
  };
  (canvas._texts = canvas._texts || []).push(rec);

  if (!label) return;
  const charW = width / label.length;
  const inkH = Math.max(1, Math.round(fontPx * 0.72));
  const inkY = y - inkH / 2;
  const rgb = parseWarna(state.fillStyle);
  for (let i = 0; i < label.length; i++) {
    if (/\s/.test(label[i])) continue;
    for (let yy = Math.floor(inkY); yy < Math.ceil(inkY + inkH); yy++) {
      for (let xx = Math.floor(x0 + i * charW); xx < Math.ceil(x0 + (i + 0.9) * charW); xx++) {
        tulisPiksel(canvas, xx, yy, rgb);
      }
    }
  }
}

/*
  Mock canvas minimal untuk THEME.compose / RENDER.renderPNG di Node.
  Cukup untuk fillRect, drawImage (dari mock canvas lain), toDataURL (PNG via pngjs),
  dan measureText/fillText/strokeText (direkam di canvas._texts + digambar kasar).
*/
function createCanvas(width, height) {
  let w = Math.max(1, width || 16);
  let h = Math.max(1, height || 16);
  /* width/height bisa diubah setelah dibuat (pola browser: canvas.width = N) */
  const canvas = {
    _data: new Uint8ClampedArray(w * h * 4),
    get width() { return w; },
    set width(v) {
      w = Math.max(1, v | 0);
      canvas._data = new Uint8ClampedArray(w * h * 4);
    },
    get height() { return h; },
    set height(v) {
      h = Math.max(1, v | 0);
      canvas._data = new Uint8ClampedArray(w * h * 4);
    },
    getContext() {
      const state = {
        fillStyle: '#000000',
        strokeStyle: '#000000',
        font: '16px sans-serif',
        textAlign: 'left',
        textBaseline: 'alphabetic',
        lineWidth: 1,
        lineJoin: 'miter',
        shadowColor: 'transparent',
        shadowBlur: 0,
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        _clip: null,
      };
      const parseColor = (c) => {
        if (typeof c !== 'string') return [0, 0, 0, 255];
        c = c.trim();
        if (c[0] === '#' && (c.length === 7 || c.length === 4)) {
          let r, g, b;
          if (c.length === 7) {
            r = parseInt(c.slice(1, 3), 16);
            g = parseInt(c.slice(3, 5), 16);
            b = parseInt(c.slice(5, 7), 16);
          } else {
            r = parseInt(c[1] + c[1], 16);
            g = parseInt(c[2] + c[2], 16);
            b = parseInt(c[3] + c[3], 16);
          }
          return [r, g, b, 255];
        }
        const m = c.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
        if (m) {
          return [
            Math.round(+m[1]),
            Math.round(+m[2]),
            Math.round(+m[3]),
            m[4] === undefined ? 255 : Math.round(parseFloat(m[4]) * 255),
          ];
        }
        if (/white/i.test(c)) return [255, 255, 255, 255];
        if (/black/i.test(c)) return [0, 0, 0, 255];
        return [0, 0, 0, 255];
      };
      const setPx = (x, y, rgba) => {
        x = x | 0; y = y | 0;
        if (x < 0 || y < 0 || x >= w || y >= h) return;
        if (state._clip) {
          const cl = state._clip;
          if (x < cl.x || y < cl.y || x >= cl.x + cl.w || y >= cl.y + cl.h) return;
        }
        const i = (y * w + x) * 4;
        const a = rgba[3] / 255;
        if (a >= 1) {
          canvas._data[i] = rgba[0];
          canvas._data[i + 1] = rgba[1];
          canvas._data[i + 2] = rgba[2];
          canvas._data[i + 3] = 255;
        } else if (a > 0) {
          canvas._data[i] = canvas._data[i] * (1 - a) + rgba[0] * a;
          canvas._data[i + 1] = canvas._data[i + 1] * (1 - a) + rgba[1] * a;
          canvas._data[i + 2] = canvas._data[i + 2] * (1 - a) + rgba[2] * a;
          canvas._data[i + 3] = 255;
        }
      };
      const ctx = {
        canvas,
        get fillStyle() { return state.fillStyle; },
        set fillStyle(v) { state.fillStyle = v; },
        get strokeStyle() { return state.strokeStyle; },
        set strokeStyle(v) { state.strokeStyle = v; },
        get font() { return state.font; },
        set font(v) { state.font = v; },
        get textAlign() { return state.textAlign; },
        set textAlign(v) { state.textAlign = v; },
        get textBaseline() { return state.textBaseline; },
        set textBaseline(v) { state.textBaseline = v; },
        get lineWidth() { return state.lineWidth; },
        set lineWidth(v) { state.lineWidth = v; },
        get lineJoin() { return state.lineJoin; },
        set lineJoin(v) { state.lineJoin = v; },
        get shadowColor() { return state.shadowColor; },
        set shadowColor(v) { state.shadowColor = v; },
        get shadowBlur() { return state.shadowBlur; },
        set shadowBlur(v) { state.shadowBlur = v; },
        get shadowOffsetX() { return state.shadowOffsetX; },
        set shadowOffsetX(v) { state.shadowOffsetX = v; },
        get shadowOffsetY() { return state.shadowOffsetY; },
        set shadowOffsetY(v) { state.shadowOffsetY = v; },
        save() { ctx._stack = ctx._stack || []; ctx._stack.push(Object.assign({}, state, { _clip: state._clip && Object.assign({}, state._clip) })); },
        restore() {
          if (ctx._stack && ctx._stack.length) {
            const s = ctx._stack.pop();
            Object.keys(state).forEach(k => { if (k !== '_clip') state[k] = s[k]; });
            state._clip = s._clip || null;
          }
        },
        beginPath() { ctx._path = []; },
        moveTo() {},
        arcTo() {},
        closePath() {},
        roundRect(x, y, w, h) { ctx._pathBox = { x, y, w, h }; },
        clip() {
          if (ctx._pathBox) state._clip = Object.assign({}, ctx._pathBox);
        },
        fillRect(x, y, fw, fh) {
          const rgba = parseColor(state.fillStyle);
          const x0 = Math.max(0, Math.floor(x));
          const y0 = Math.max(0, Math.floor(y));
          const x1 = Math.min(w, Math.ceil(x + fw));
          const y1 = Math.min(h, Math.ceil(y + fh));
          for (let yy = y0; yy < y1; yy++) {
            for (let xx = x0; xx < x1; xx++) setPx(xx, yy, rgba);
          }
        },
        drawImage(img, dx, dy, dw, dh) {
          const sw = img.naturalWidth || img.width;
          const sh = img.naturalHeight || img.height;
          dw = dw === undefined ? sw : dw;
          dh = dh === undefined ? sh : dh;
          const src = img._data;
          if (!src) {
            /* solid fallback */
            const rgba = [20, 20, 30, 255];
            for (let yy = 0; yy < dh; yy++) {
              for (let xx = 0; xx < dw; xx++) setPx(dx + xx, dy + yy, rgba);
            }
            return;
          }
          for (let yy = 0; yy < dh; yy++) {
            const sy = Math.min(sh - 1, Math.floor(yy * sh / dh));
            for (let xx = 0; xx < dw; xx++) {
              const sx = Math.min(sw - 1, Math.floor(xx * sw / dw));
              const si = (sy * sw + sx) * 4;
              setPx(dx + xx, dy + yy, [src[si], src[si + 1], src[si + 2], src[si + 3]]);
            }
          }
        },
        measureText(text) {
          const size = parseInt(String(state.font).match(/(\d+)px/) && String(state.font).match(/(\d+)px/)[1], 10) || 16;
          return { width: String(text || '').length * size * 0.6 };
        },
        fillText(text, x, y) { catatDanGambarTeks(ctx, canvas, state, text, x, y, false); },
        strokeText(text, x, y) { catatDanGambarTeks(ctx, canvas, state, text, x, y, true); },
      };
      return ctx;
    },
    _texts: [],
    _textBoxes: [],
    toDataURL() {
      const png = new PNG({ width: w, height: h });
      png.data = Buffer.from(canvas._data);
      const buf = PNG.sync.write(png);
      return 'data:image/png;base64,' + buf.toString('base64');
    },
  };
  return canvas;
}

/* data URL PNG → ImageData-like (lewat pngjs) */
function canvasToImageData(dataUrl) {
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  const png = PNG.sync.read(buf);
  return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
}

module.exports = {
  ROOT, FIXTURES, CORE, readPng, readJpeg, readFixture, readHeif,
  matrixToImage, scan, toMasked, createCanvas, canvasToImageData,
};
