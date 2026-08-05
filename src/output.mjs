const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u001b]/g;

export function safeText(value) {
  return String(value).replace(CONTROL_CHARACTERS, (character) => {
    const code = character.codePointAt(0).toString(16).padStart(2, '0');
    return `\\u${code}`;
  });
}

export function writeResult(value, options = {}) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  if (typeof value === 'string') {
    process.stdout.write(`${safeText(value)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
