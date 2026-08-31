export function prepareInput(raw) {
  const input = raw.trim();
  if (!input) return '';
  if (input.length > 131072)
    throw Error('This link is too long. The limit is 128 KiB.');
  if (/^https?:\/\//i.test(input)) return input;
  // A pasted domain is convenient; never reinterpret another URL scheme.
  if (
    /^[a-z][a-z\d+.-]*:/i.test(input) &&
    !/^[^\s/:]+\.\S+:\d+(?:[/?#]|$)/.test(input)
  )
    throw Error('Use a link that starts with http:// or https://.');
  if (/^[^\s/?#:@]+\.[^\s/?#:@]+(?::\d+)?(?:[/?#]|$)/u.test(input))
    return 'https://' + input;
  throw Error('Paste a complete web address, like https://example.com.');
}

export function friendlyError(error) {
  const message = String(error?.message || error);
  if (/Compressed link exceeds/i.test(message))
    return 'The compressed link exceeds the 8,192-character limit. Try a shorter address.';
  if (/limit|large|long/i.test(message))
    return 'This link is too long. The limit is 128 KiB.';
  if (/whitespace|control/i.test(message))
    return 'Remove spaces or line breaks inside the link, then try again.';
  if (/Unicode/i.test(message))
    return 'That link contains a character we can’t read. Try copying it again.';
  if (/^Use a link|^Paste a complete/.test(message)) return message;
  return 'That doesn’t look like a valid web address. Check the link and try again.';
}
