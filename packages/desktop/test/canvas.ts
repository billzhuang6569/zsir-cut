// A deterministic Canvas 2D recorder shared by preview/renderer contract tests.
export function recordingCanvas() {
  const calls: unknown[][] = [];
  let alpha = 1;
  const alphas: number[] = [];
  const methods = Object.fromEntries(
    [
      "save",
      "restore",
      "fillText",
      "strokeText",
      "beginPath",
      "roundRect",
      "fill",
      "clearRect",
      "scale",
      "translate",
      "rect",
      "clip",
      "fillRect",
    ].map((name) => [name, (...args: unknown[]) => calls.push([name, ...args])]),
  );
  const context = new Proxy(
    {
      ...methods,
      get globalAlpha() {
        return alpha;
      },
      set globalAlpha(value: number) {
        alpha = value;
      },
      save: () => {
        calls.push(["save"]);
        alphas.push(alpha);
      },
      restore: () => {
        calls.push(["restore"]);
        alpha = alphas.pop() ?? 1;
      },
      measureText: (text: string) => ({
        width: [...text].length * 10,
        actualBoundingBoxAscent: 8,
        actualBoundingBoxDescent: 2,
      }),
    },
    {
      set(target, key, value) {
        calls.push([key, value]);
        Reflect.set(target, key, value);
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  return { calls, context };
}
