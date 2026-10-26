export type Token = { index: number; text: string; start_ms: number; end_ms: number };

export function pcmSample(sample: number, id: number, tokens: Token[], external = false): [number, number] {
  const shifted = external ? sample - 96000 : sample;
  if (shifted < 0) return [0, 0];
  const phase = shifted % 48000;
  const pulse = phase < 1920 ? Math.sin((2 * Math.PI * 2000 * phase) / 48000) * 0.42 : 0;
  let word = 0;
  if (id === 1 || id === 11 || external) {
    const token = tokens.find((item) => shifted >= item.start_ms * 48 && shifted < item.start_ms * 48 + 1920);
    if (token)
      word = Math.sin((2 * Math.PI * (600 + 40 * (token.index % 20)) * (shifted - token.start_ms * 48)) / 48000) * 0.24;
  }
  const identify = external ? 0 : Math.sin((2 * Math.PI * (200 + 10 * id) * shifted) / 48000) * 0.025;
  return [Math.max(-1, Math.min(1, pulse + word)), identify];
}

export function wavPcm24(seconds: number, id: number, channels: 1 | 2, tokens: Token[], external = false): Buffer {
  const samples = seconds * 48000;
  const output = Buffer.alloc(44 + samples * channels * 3);
  output.write("RIFF", 0);
  output.writeUInt32LE(output.length - 8, 4);
  output.write("WAVEfmt ", 8);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(channels, 22);
  output.writeUInt32LE(48000, 24);
  output.writeUInt32LE(48000 * channels * 3, 28);
  output.writeUInt16LE(channels * 3, 32);
  output.writeUInt16LE(24, 34);
  output.write("data", 36);
  output.writeUInt32LE(samples * channels * 3, 40);
  let tokenIndex = 0;
  for (let sample = 0; sample < samples; sample++) {
    const shifted = external ? sample - 96000 : sample;
    while (tokenIndex < tokens.length && shifted >= tokens[tokenIndex]!.start_ms * 48 + 1920) tokenIndex++;
    const active = tokens[tokenIndex];
    const values = pcmSample(sample, id, active ? [active] : [], external);
    for (let channel = 0; channel < channels; channel++) {
      const value = Math.round(values[channel]! * 8388607);
      const offset = 44 + (sample * channels + channel) * 3;
      output[offset] = value & 255;
      output[offset + 1] = (value >> 8) & 255;
      output[offset + 2] = (value >> 16) & 255;
    }
  }
  return output;
}
