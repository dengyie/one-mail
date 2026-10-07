// @ts-check
/**
 * Quote an untrusted mail field as literal Markdown text. HTML escaping alone
 * would still allow Markdown images to fetch remote tracking resources.
 * @param {string} value
 * @returns {string}
 */
export const markdownText = (value) => value.replace(
  /[&<>"'\\`*_{}\[\]()#+.!|~:@/-]/g,
  character => `&#${character.charCodeAt(0)};`,
)
