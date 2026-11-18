const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
const p95 = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1];

async function sampleFrames(step: (i: number) => void) {
  const samples: number[] = [];
  let before = await frame();
  for (let i = 0; i < 90; i++) {
    step(i);
    const now = await frame();
    samples.push(now - before);
    before = now;
  }
  return samples;
}

function nextPaint(test: () => boolean, action: () => void) {
  return new Promise<number>((resolve, reject) => {
    const start = performance.now();
    action();
    const check = () => {
      if (test()) resolve(performance.now() - start);
      else if (performance.now() - start > 5000) reject(new Error("Timeline update was not visible within 5s"));
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}

export async function runTimelinePerf({ drops = 0 }: { drops?: number } = {}) {
  const timeline = document.querySelector<HTMLElement>(".zc-timeline");
  const zoom = document.querySelector<HTMLInputElement>('input[aria-label="时间线缩放"]');
  if (!timeline || !zoom) throw new Error("Open a timeline first");
  const initialScroll = timeline.scrollLeft;
  const initialZoom = Number(zoom.value);
  const { left, right } = timeline.getBoundingClientRect();
  const center = Math.round((left + right) / 2);
  const setZoom = (value: number) => {
    timeline.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        clientX: center,
        deltaY: value,
      }),
    );
  };
  const pointer = (target: Element, type: string, x: number, y: number, altKey = false) => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 97,
        pointerType: "mouse",
        clientX: x,
        clientY: y,
        button: 0,
        buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
        altKey,
      }),
    );
  };
  let frameBudget = 0;
  const rows: { phase: string; samples: number; p95Ms: number | undefined; maxMs: number; longFrames?: number }[] = [];
  const record = (phase: string, samples: number[], frames = false) =>
    rows.push({
      phase,
      samples: samples.length,
      p95Ms: p95(samples),
      maxMs: Math.max(...samples),
      ...(frames ? { longFrames: samples.filter((sample) => sample > frameBudget).length } : {}),
    });
  try {
    const idle = await sampleFrames(() => {});
    frameBudget = ([...idle].sort((a, b) => a - b)[45] ?? 16.7) * 1.5;
    record("idle frame", idle, true);
    record(
      "scroll frame",
      await sampleFrames((i) => {
        timeline.scrollLeft = ((timeline.scrollWidth - timeline.clientWidth) * i) / 89;
      }),
      true,
    );
    record("zoom frame", await sampleFrames((i) => setZoom(i % 18 < 9 ? -30 : 30)), true);
    timeline.scrollLeft = 0;
    await frame();
    await frame();
    const clip = timeline.querySelector<HTMLElement>(".zc-track-video .zc-clip-video");
    if (!clip) throw new Error("No video clip available to drag");
    const bounds = clip.getBoundingClientRect();
    const nameRight = timeline.querySelector(".zc-track-name")?.getBoundingClientRect().right ?? left;
    const x = Math.round(Math.max(bounds.left, nameRight) + 20);
    const y = Math.round(bounds.top + bounds.height / 2);
    if (x + 80 >= right || x >= bounds.right) throw new Error("Timeline is too narrow for the drag sample");
    pointer(clip, "pointerdown", x, y);
    try {
      const samples: number[] = [];
      for (let i = 0; i < 30; i++) {
        const previous = document.querySelector<HTMLElement>(".zc-drag-feedback")?.style.left;
        samples.push(
          await nextPaint(
            () => {
              const current = document.querySelector<HTMLElement>(".zc-drag-feedback")?.style.left;
              return !!current && current !== previous;
            },
            () => pointer(clip, "pointermove", x + 12 + (i % 2) * 48, y),
          ),
        );
      }
      record("drag feedback", samples);
      record("drag frame", await sampleFrames((i) => pointer(clip, "pointermove", x + 12 + (i % 2) * 48, y)), true);
    } finally {
      pointer(clip, "pointercancel", x, y);
    }

    if (drops > 0) {
      const card = document.querySelector<HTMLElement>(".zc-media-card[data-media-id]");
      const lane = timeline.querySelector(".zc-track-video .zc-track-lane");
      if (!card || !lane) throw new Error("Open the media library beside a video lane");
      const cardBox = card.getBoundingClientRect();
      const box = lane.getBoundingClientRect();
      const samples: number[] = [];
      for (let i = 0; i < drops; i++) {
        const dropX = x + (i % 8) * 8;
        const dropY = box.top + 12;
        pointer(card, "pointerdown", cardBox.left + 1, cardBox.top + 1, true);
        pointer(card, "pointermove", dropX, dropY, true);
        const ids = new Set(
          [...lane.querySelectorAll<HTMLElement>("[data-selection-id]")].map((item) => item.dataset.selectionId),
        );
        samples.push(
          await nextPaint(
            () =>
              [...lane.querySelectorAll<HTMLElement>("[data-selection-id]")].some(
                (item) => !ids.has(item.dataset.selectionId),
              ),
            () => pointer(card, "pointerup", dropX, dropY, true),
          ),
        );
        await frame();
      }
      record("media release to visible clip", samples);
    }
  } finally {
    if (Number(zoom.value) !== initialZoom) {
      // The wheel step is proportional to zoom, so restore the exact value via the slider.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(zoom, String(initialZoom));
      zoom.dispatchEvent(new Event("input", { bubbles: true }));
      await frame();
    }
    timeline.scrollLeft = initialScroll;
    console.table(rows);
  }
  return rows;
}
