// 预览在剪点处是否卡顿：在 WebKit（macOS 上 Tauri 用的内核）里打开桌面版界面，
// 从每个剪点前 2 秒开始播放 4 秒，记录上层 <video>（没有 data-preroll 的那个）的帧间隔、seeking 事件，
// 以及新片段第一帧和旧片段最后一帧离入点、出点有多远。
// playwright 不是仓库依赖：在装了 playwright 的目录里运行，例如
//   cd .tmp/pw && node ../../tools/acceptance/preview_seam.mjs <界面URL> <宿主端口> <令牌> <工程>
// 宿主要先用同一个工程启动：node packages/app-host/dist/index.js --project <工程> --port <端口> --token <令牌>
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const { webkit } = createRequire(`${process.cwd()}/`)("playwright");
const [url, port, token, projectPath] = process.argv.slice(2);
if (!projectPath) {
  console.error("用法：preview_seam.mjs <界面URL> <宿主端口> <令牌> <工程>");
  process.exit(2);
}
const seconds = (t) => {
  const [n, d = "1"] = t.slice(0, -1).split("/");
  return Number(n) / Number(d);
};
const project = JSON.parse(readFileSync(projectPath, "utf8"));
const timeline = project.timelines[0];
const rate = seconds(`${timeline.edit_rate ?? project.timelines[0].format?.edit_rate ?? "25"}s`);
const video = timeline.tracks.find((t) => t.kind === "video");
const cuts = video.clips.slice(1).map((c, i) => {
  const prev = video.clips[i];
  const speed = (clip) => (clip.speed && clip.speed !== "map" ? seconds(`${clip.speed}s`) : 1);
  return {
    at: seconds(c.timeline_start),
    srcIn: seconds(c.source_start),
    srcOut: seconds(prev.source_start) + seconds(prev.duration) * speed(prev),
    rate: seconds(`${project.media.find((m) => m.id === c.media_id)?.video?.rate ?? "30"}s`),
  };
});

const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url);
await page.evaluate(
  async ([port, token]) => {
    window.__ZCUT_HOST__ = { port: Number(port), token };
    document.getElementById("root").innerHTML = "";
    await import(`/src/main.tsx?t=${Date.now()}`);
  },
  [port, token],
);
await page.waitForSelector("video", { timeout: 15000 });
await page.waitForTimeout(2500);
// 缩小时间线，让所有剪点都在标尺可点击的范围内。
await page.evaluate(() => {
  const r = document.querySelector('input[aria-label="时间线缩放"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(r, String(r.min || 1));
  r.dispatchEvent(new Event("input", { bubbles: true }));
  r.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(500);
const scale = await page.evaluate(() => Number(document.querySelector('input[aria-label="时间线缩放"]').value));
const play = () => page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "播放" || b.getAttribute("aria-label") === "暂停")?.click());

let failed = false;
for (const { at: cut, srcIn, srcOut, rate: mediaRate } of cuts) {
  const box = await page.locator('[aria-label="时间标尺"]').boundingBox();
  await page.mouse.click(box.x + Math.max(0, cut - 2) * scale, box.y + box.height / 2);
  await page.waitForTimeout(1500);
  // 每次都重新挂监听：实现用多个 <video> 轮流播放时，只记上层的那个（没有 data-preroll）。
  await page.evaluate(() => {
    const log = (window.__seam = { events: [], frames: [] });
    const top = (v) => !v.hasAttribute("data-preroll");
    for (const v of document.querySelectorAll("video")) {
      for (const e of ["waiting", "seeking", "stalled"])
        v.addEventListener(e, () => {
          if (top(v)) log.events.push([e, v.currentTime]);
        });
      const f = (now, meta) => {
        if (top(v)) log.frames.push([now, meta.mediaTime]);
        v.requestVideoFrameCallback(f);
      };
      v.requestVideoFrameCallback(f);
    }
  });
  await play();
  await page.waitForTimeout(4000);
  await play();
  const { events, frames } = await page.evaluate(() => window.__seam);
  frames.sort((a, b) => a[0] - b[0]);
  let worst = 0;
  // 第一帧前的起播延迟不算，从第 3 帧起看间隔。
  for (let i = 3; i < frames.length; i++) worst = Math.max(worst, frames[i][0] - frames[i - 1][0]);
  // 素材时间跳变的地方就是剪点：前一帧属于旧片段，后一帧属于新片段。
  const jump = frames.findIndex((f, i) => i > 0 && Math.abs(f[1] - frames[i - 1][1]) > 0.5);
  const frame = 1 / mediaRate;
  const firstIn = jump > 0 ? frames[jump][1] - srcIn : null;
  const lastOut = jump > 0 ? frames[jump - 1][1] - srcOut : null;
  const ok =
    worst <= (2 / rate) * 1000 + 20 &&
    !events.some(([e]) => e === "seeking") &&
    jump > 0 &&
    Math.abs(firstIn) <= frame + 0.005 &&
    lastOut <= frame + 0.005;
  failed ||= !ok;
  console.log(
    JSON.stringify({
      cut,
      ok,
      frames: frames.length,
      worstGapMs: Math.round(worst),
      firstFrameFromInMs: firstIn === null ? null : Math.round(firstIn * 1000),
      lastFrameFromOutMs: lastOut === null ? null : Math.round(lastOut * 1000),
      events,
    }),
  );
}
await browser.close();
process.exit(failed ? 1 : 0);
