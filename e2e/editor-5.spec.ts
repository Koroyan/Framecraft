import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test, expect, type Page } from '@playwright/test';
import { expectNoHorizontalOverflow, register } from './helpers';

/*
 * Framecraft 5.0 usability tasks in a real browser, on real video files made here with FFmpeg.
 * No paid AI is used: every step is free (editing, tracking, export with FFmpeg).
 *   A — the assistant collapses, releases its space, and keeps conversation + draft (also after reload)
 *   B — click an object, recolour it, track it, export: the exported pixels follow the moving object
 *   D — basic manual edit: 3 clips, reorder, trim, title, music, transition, export MP4
 *   G — responsive layout at 1366, 1920 and tablet width
 *   H — no lost work: edits, object, title, assistant hidden, workspace switch, reload
 */

const SHOTS = 'test-results/editor-5';
const ffmpegBin = (createRequire(path.resolve('apps/server/package.json'))('@ffmpeg-installer/ffmpeg') as { path: string }).path;
const ffprobeBin = (createRequire(path.resolve('apps/server/package.json'))('@ffprobe-installer/ffprobe') as { path: string }).path;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-e2e5-'));
test.afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

const ff = (args: string[]) => execFileSync(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

/** A 4 s clip: beige wall, red box moving right (60→500 px) and growing — the Task B subject. */
function movingBox(file: string) {
  const W = 640, H = 360, fps = 30, frames = 4 * fps;
  const buf = Buffer.alloc(W * H * 3 * frames);
  for (let f = 0; f < frames; f++) {
    const t = f / fps;
    const size = 80 + 6 * t;
    const bx = 60 + 110 * t - (size - 80) / 2;
    const by = 140 - (size - 80) / 2;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = ((f * H + y) * W + x) * 3;
        const inBox = x >= bx && x < bx + size && y >= by && y < by + size;
        buf[i] = inBox ? 0xcc : 0xd6;
        buf[i + 1] = inBox ? 0x22 : 0xc4;
        buf[i + 2] = inBox ? 0x33 : 0xa8;
      }
  }
  const raw = `${file}.rgb`;
  fs.writeFileSync(raw, buf);
  ff(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(fps), '-i', raw, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', file]);
  fs.rmSync(raw, { force: true });
}

/** A 3 s test-pattern clip with a tone (each one looks different). */
function patternClip(file: string, source: string, hz: number) {
  ff(['-f', 'lavfi', '-i', `${source}=s=640x360:r=30:d=3`, '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=3`, '-shortest', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
}

async function call<T>(page: Page, method: string, url: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u as string, { method: m as string, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      const text = await r.text();
      if (!r.ok) throw new Error(`${m} ${u} → ${r.status} ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    },
    [method, url, body] as const,
  ) as Promise<T>;
}

async function upload(page: Page, file: string, mimeType: string, projectId: string): Promise<{ id: string }> {
  const r = await page.context().request.post('/api/assets', { multipart: { rightsConfirmed: 'true', projectId, file: { name: path.basename(file), mimeType, buffer: fs.readFileSync(file) } } }); // fields before the file: the server reads them first
  expect(r.status(), await r.text()).toBe(201);
  return ((await r.json()) as { asset: { id: string } }).asset;
}

async function newEditProject(page: Page, aspectRatio = '16:9') {
  const { project } = await call<{ project: { id: string } }>(page, 'POST', '/api/projects', { title: `E2E edit ${Date.now()}`, kind: 'edit', aspectRatio });
  return project.id;
}

async function setTimeline(page: Page, projectId: string, mutate: (t: Record<string, unknown> & { clips: Record<string, unknown>[] }) => void) {
  const { timeline } = await call<{ timeline: Record<string, unknown> & { clips: Record<string, unknown>[] } }>(page, 'GET', `/api/projects/${projectId}/timeline`);
  mutate(timeline);
  await call(page, 'PUT', `/api/projects/${projectId}/timeline`, { timeline, autosave: false, label: 'e2e setup' });
}

async function openEditor(page: Page, projectId: string) {
  await page.goto(`/app/editor/${projectId}`);
  await expect(page.getByRole('region', { name: 'Preview' })).toBeVisible();
}

const box = async (page: Page, name: string) => (await page.getByRole(name === 'Properties' ? 'complementary' : 'region', { name }).boundingBox())!;

function probe(file: string) {
  return JSON.parse(execFileSync(ffprobeBin, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString()) as { format: { duration: string }; streams: { codec_type: string }[] };
}
function frameRgb(file: string, t: number, w: number, h: number) {
  const out = path.join(work, `f${Math.random().toString(36).slice(2)}.rgb`);
  ff(['-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, out]);
  const b = fs.readFileSync(out);
  fs.rmSync(out, { force: true });
  return b;
}
const hueAt = (buf: Buffer, w: number, x: number, y: number) => {
  const i = (Math.round(y) * w + Math.round(x)) * 3;
  const [r, g, b] = [buf[i]! / 255, buf[i + 1]! / 255, buf[i + 2]! / 255];
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
};

async function exportAndDownload(page: Page, name: string): Promise<string> {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: /Render MP4/ }).click();
  const link = page.getByTestId('export-download');
  await expect(link).toBeVisible({ timeout: 240_000 });
  const href = await link.getAttribute('href');
  const res = await page.context().request.get(href!);
  expect(res.ok()).toBe(true);
  const file = path.join(work, name);
  fs.writeFileSync(file, await res.body());
  await page.keyboard.press('Escape');
  return file;
}

test('A — assistant collapses, releases space, keeps conversation and draft (also after reload)', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await register(page);
  const pid = await newEditProject(page);
  const clip = path.join(work, 'a.mp4');
  patternClip(clip, 'testsrc2', 440);
  const a = await upload(page, clip, 'video/mp4', pid);
  await setTimeline(page, pid, (t) => t.clips.push({ id: 'c1', assetId: a.id, inSec: 0, outSec: 3 }));
  await openEditor(page, pid);

  const before = await box(page, 'Preview');
  await page.getByRole('button', { name: /^Assistant/ }).click();
  const input = page.getByLabel('Message the assistant');
  await expect(input).toBeVisible();
  // A free, instant request (no AI call): proposes a change with Preview / Apply.
  await input.fill('Make the music quieter and add smooth transitions');
  await input.press('Enter');
  await expect(page.getByText('Understood instantly — no AI call, no credits')).toBeVisible();
  await input.fill('draft that must survive');
  const docked = await box(page, 'Preview');
  expect(docked.width).toBeLessThan(before.width); // the docked assistant takes room…
  await page.screenshot({ path: `${SHOTS}/A1-assistant-docked.png` });

  await page.keyboard.press('Control+j'); // minimise
  await expect(page.getByLabel('Message the assistant')).toHaveCount(0);
  const released = await box(page, 'Preview');
  expect(released.width).toBeGreaterThanOrEqual(before.width - 2); // …and gives it back when collapsed
  await page.screenshot({ path: `${SHOTS}/A2-assistant-collapsed.png` });

  await page.keyboard.press('Control+j'); // restore
  await expect(page.getByLabel('Message the assistant')).toHaveValue('draft that must survive');
  await expect(page.getByText('Make the music quieter and add smooth transitions')).toBeVisible();

  // Dock at the bottom, then floating: same conversation every time.
  await page.getByRole('button', { name: 'Dock at the bottom' }).click();
  await expect(page.getByLabel('Message the assistant')).toHaveValue('draft that must survive');
  await page.getByRole('button', { name: 'Float over the editor' }).click();
  await expect(page.getByText('Make the music quieter and add smooth transitions')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/A3-assistant-floating.png` });
  await page.getByRole('button', { name: 'Dock right' }).click();

  await page.reload();
  await expect(page.getByRole('region', { name: 'Preview' })).toBeVisible();
  await expect(page.getByLabel('Message the assistant')).toHaveValue('draft that must survive');
  await expect(page.getByText('Make the music quieter and add smooth transitions')).toBeVisible();
  await page.keyboard.press('Control+j');
  await call(page, 'DELETE', `/api/projects/${pid}`, {});
});

test('B — select a moving object, recolour, track, export: the colour follows it', async ({ page }) => {
  test.setTimeout(420_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await register(page);
  const pid = await newEditProject(page, '16:9');
  const clip = path.join(work, 'box.mp4');
  movingBox(clip);
  const a = await upload(page, clip, 'video/mp4', pid);
  await setTimeline(page, pid, (t) => t.clips.push({ id: 'c1', assetId: a.id, inSec: 0, outSec: 4 }));
  await openEditor(page, pid);
  // Pause at 1 s, where the box is at x≈170..250 of 640.
  await page.getByTestId('timeline-ruler').click({ position: { x: 5, y: 5 } });
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight');
  await page.getByRole('button', { name: 'Select object' }).click();
  const layer = page.getByTestId('object-layer');
  const lb = (await layer.boundingBox())!;
  // Source and frame are both 16:9: the box centre at 1 s is (210, 180) of 640×360.
  await page.waitForTimeout(800);
  await page.mouse.click(lb.x + (210 / 640) * lb.width, lb.y + (180 / 360) * lb.height);
  const toolbar = page.getByTestId('object-toolbar');
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toContainText('Red object');
  await toolbar.getByRole('button', { name: 'Colour' }).click();
  await page.getByRole('button', { name: 'Blue', exact: true }).click();
  // Tracking starts by itself for an effect on the whole clip.
  await expect(toolbar.getByRole('button', { name: /Re-track/ })).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('Escape');
  await page.screenshot({ path: `${SHOTS}/B1-object-recoloured.png` });
  // Saved with the track.
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 15_000 });
  const { timeline } = await call<{ timeline: { clips: { objects?: { effects: { type: string }[]; mask: { track?: { points: unknown[] } } }[] }[] } }>(page, 'GET', `/api/projects/${pid}/timeline`);
  const obj = timeline.clips[0]!.objects![0]!;
  expect(obj.effects[0]!.type).toBe('recolor');
  expect(obj.mask.track!.points.length).toBeGreaterThan(30);

  const out = await exportAndDownload(page, 'b.mp4');
  for (const t of [0.4, 2, 3.4]) {
    const f = frameRgb(out, t, 640, 360);
    const size = 80 + 6 * t;
    const cx = 60 + 110 * t - (size - 80) / 2 + size / 2;
    const h = hueAt(f, 640, cx, 180);
    expect(h, `box hue at ${t}s`).toBeGreaterThan(200);
    expect(h, `box hue at ${t}s`).toBeLessThan(240);
    const wall = hueAt(f, 640, 20, 30);
    expect(wall, 'wall unchanged').toBeLessThan(50);
  }
  await call(page, 'DELETE', `/api/projects/${pid}`, {});
});

test('D — basic manual edit: three clips, reorder, trim, title, music, transition, export', async ({ page }) => {
  test.setTimeout(420_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await register(page);
  const pid = await newEditProject(page, '16:9');
  const files = [['d1.mp4', 'testsrc2', 330], ['d2.mp4', 'smptebars', 440], ['d3.mp4', 'rgbtestsrc', 550]] as const;
  for (const [f, src, hz] of files) patternClip(path.join(work, f), src, hz);
  for (const [f] of files) await upload(page, path.join(work, f), 'video/mp4', pid);
  const music = path.join(work, 'music.wav');
  ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=12', music]);
  await upload(page, music, 'audio/wav', pid);
  await openEditor(page, pid);

  // Import: add the three clips from the Media panel.
  const media = page.getByTestId('tool-panel');
  for (const [f] of files) await media.getByTitle('Add to the end of the timeline').filter({ hasText: f }).click();
  await expect(page.getByRole('button', { name: /^Clip 3/ })).toBeVisible();
  // Reorder: clip 3 to the front (Earlier ×2).
  await page.getByRole('button', { name: /^Clip 3/ }).click();
  await page.getByRole('button', { name: 'Earlier' }).click();
  await page.getByRole('button', { name: 'Earlier' }).click();
  // Trim: drag the end of the (new) clip 1 to the left by ~1 s.
  const ruler = (await page.getByTestId('timeline-ruler').boundingBox())!;
  const pps = ruler.width / 9; // 3 clips × 3 s
  const handle = page.getByRole('slider', { name: 'Trim the end of clip 1' });
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 - pps, hb.y + hb.height / 2, { steps: 8 });
  await page.mouse.up();
  // Title: Text tool → Bold yellow (a text layer at the playhead).
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: /Bold yellow/ }).click();
  // Music: Audio tool → the uploaded track.
  await page.getByRole('button', { name: 'Audio', exact: true }).click();
  await page.getByRole('button', { name: /music\.wav/ }).first().click();
  // Transition: Transitions tool → Dissolve on every cut.
  await page.getByRole('button', { name: 'Transitions', exact: true }).click();
  await page.getByText('Dissolve', { exact: true }).locator('xpath=ancestor::div[1]/..').getByRole('button', { name: 'All' }).click();
  // Preview plays.
  await page.keyboard.press('Home');
  await page.keyboard.press('Space');
  await page.waitForTimeout(1200);
  await page.keyboard.press('Space');
  await page.screenshot({ path: `${SHOTS}/D1-manual-edit.png` });
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 15_000 });

  const { timeline } = await call<{ timeline: { clips: { assetId: string; inSec: number; outSec: number; transition?: { type: string } }[]; layers: { kind: string }[]; audio: unknown[] } }>(page, 'GET', `/api/projects/${pid}/timeline`);
  expect(timeline.clips).toHaveLength(3);
  expect(timeline.clips[0]!.outSec - timeline.clips[0]!.inSec).toBeLessThan(2.6); // trimmed
  expect(timeline.clips[0]!.transition?.type).toBe('dissolve');
  expect(timeline.layers.some((l) => l.kind === 'text')).toBe(true);
  expect(timeline.audio).toHaveLength(1);

  const out = await exportAndDownload(page, 'd.mp4');
  const meta = probe(out);
  const expected = timeline.clips.reduce((s, c) => s + (c.outSec - c.inSec), 0) - 2 * 0.5; // two dissolves overlap 0.5 s
  expect(Math.abs(Number(meta.format.duration) - expected)).toBeLessThan(0.4);
  expect(meta.streams.some((s) => s.codec_type === 'audio')).toBe(true);
  await call(page, 'DELETE', `/api/projects/${pid}`, {});
});

test('G — responsive: 1366, 1920 and tablet width keep the preview usable and panels apart', async ({ page }) => {
  test.setTimeout(240_000);
  await register(page);
  const pid = await newEditProject(page, '9:16');
  const clip = path.join(work, 'g.mp4');
  patternClip(clip, 'testsrc2', 440);
  const a = await upload(page, clip, 'video/mp4', pid);
  await setTimeline(page, pid, (t) => t.clips.push({ id: 'c1', assetId: a.id, inSec: 0, outSec: 3 }));
  for (const [w, h, name] of [[1366, 768, '1366'], [1920, 1080, '1920'], [820, 1180, 'tablet']] as const) {
    await page.setViewportSize({ width: w, height: h });
    await openEditor(page, pid);
    await expectNoHorizontalOverflow(page);
    const preview = await box(page, 'Preview');
    expect(preview.height).toBeGreaterThan(220);
    const frame = (await page.getByTestId('preview-frame').boundingBox())!;
    expect(frame.height).toBeGreaterThan(160);
    if (w >= 1024) {
      const props = await box(page, 'Properties');
      expect(preview.x + preview.width).toBeLessThanOrEqual(props.x + 1); // no overlap
      await page.getByRole('button', { name: /^Assistant/ }).click();
      const withAssistant = await box(page, 'Preview');
      expect(withAssistant.width).toBeGreaterThan(260);
      await page.screenshot({ path: `${SHOTS}/G-${name}-assistant.png` });
      await page.keyboard.press('Control+j');
    }
    await page.screenshot({ path: `${SHOTS}/G-${name}.png`, fullPage: w < 1024 });
  }
  await call(page, 'DELETE', `/api/projects/${pid}`, {});
});

test('H — no lost work: edits, object, title, hidden assistant, workspace switch, reload', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await register(page);
  const pid = await newEditProject(page, '16:9');
  const clip = path.join(work, 'h.mp4');
  movingBox(clip);
  const a = await upload(page, clip, 'video/mp4', pid);
  await setTimeline(page, pid, (t) => t.clips.push({ id: 'c1', assetId: a.id, inSec: 0, outSec: 4 }));
  await openEditor(page, pid);
  // Edit the clip: 1.5× speed.
  await page.getByRole('button', { name: /^Clip 1/ }).click();
  await page.getByRole('button', { name: '1.5×' }).click();
  // An object with an effect (blur) — on the box at the first frame.
  await page.keyboard.press('Home');
  await page.getByRole('button', { name: 'Select object' }).click();
  const lb = (await page.getByTestId('object-layer').boundingBox())!;
  await page.waitForTimeout(600);
  await page.mouse.click(lb.x + (100 / 640) * lb.width, lb.y + (180 / 360) * lb.height);
  await expect(page.getByTestId('object-toolbar')).toBeVisible();
  await page.getByTestId('object-toolbar').getByRole('button', { name: 'Blur' }).click();
  await page.getByTestId('object-toolbar').getByRole('radio', { name: 'Blur' }).click();
  await expect(page.getByTestId('object-toolbar').getByRole('radio', { name: 'Blur' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // A title.
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: /Bold yellow/ }).click();
  // Assistant opened then hidden; workspace switched away and back.
  await page.keyboard.press('Control+j');
  await page.keyboard.press('Control+j');
  await page.getByRole('tab', { name: /Storyboard/ }).click();
  await page.getByRole('tab', { name: /^Edit/ }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await expect(page.getByRole('region', { name: 'Preview' })).toBeVisible();
  const { timeline } = await call<{ timeline: { clips: { speed: number; objects?: { effects: { type: string }[] }[] }[]; layers: { kind: string }[] } }>(page, 'GET', `/api/projects/${pid}/timeline`);
  expect(timeline.clips[0]!.speed).toBe(1.5);
  expect(timeline.clips[0]!.objects?.[0]?.effects.some((e) => e.type === 'blur')).toBe(true);
  expect(timeline.layers.some((l) => l.kind === 'text')).toBe(true);
  const { versions } = await call<{ versions: unknown[] }>(page, 'GET', `/api/projects/${pid}/versions`);
  expect(versions.length).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: /^Clip 1/ })).toContainText('1.5×');
  await page.screenshot({ path: `${SHOTS}/H-after-reload.png` });
  await call(page, 'DELETE', `/api/projects/${pid}`, {});
});
