// A deterministic Canvas 2D recorder shared by preview/renderer contract tests.
export function recordingCanvas() {
  const calls: unknown[][] = [];
  const methods = Object.fromEntries(
    ["save", "restore", "fillText", "strokeText", "beginPath", "roundRect", "fill", "clearRect"].map((name) => [
      name,
      (...args: unknown[]) => calls.push([name, ...args]),
    ]),
  );
  const context = new Proxy(
    {
      ...methods,
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
