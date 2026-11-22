// Escapes control characters (keeping newlines and tabs) so text from configs,
// file names, and Git output can't send escape sequences to the terminal.
export function printable(text) {
  return String(text).replace(
    /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

// Quotes `text` for a shell command that the user may copy.
export function shellQuote(text) {
  return /^[\w@%+=:,./-]+$/.test(text)
    ? text
    : `'${text.replaceAll("'", "'\\''")}'`;
}

export function report(action, issues) {
  if (issues.length) {
    for (const issue of issues) console.error(printable(issue));
    return 1;
  }
  console.log(`Ultrahome ${action} complete`);
  return 0;
}
