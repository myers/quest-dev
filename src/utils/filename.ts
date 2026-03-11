/**
 * Filename generation utilities for screenshots
 */

/**
 * Slugify a caption for use in filenames.
 * Lowercase, replace non-alphanumeric with dashes, collapse runs, trim, truncate to 25 chars.
 */
export function slugifyCaption(caption: string): string {
  return caption
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 25)
    .replace(/-$/, "");
}

/**
 * Generate UTC timestamp filename
 * Format: screenshot-YYYY-MM-DD-HH-MM-SS-Z.jpg
 * With caption: screenshot-YYYY-MM-DD-HH-MM-SS-Z-slug.jpg
 */
export function generateScreenshotFilename(date: Date = new Date(), caption?: string): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');

  const base = `screenshot-${year}-${month}-${day}-${hours}-${minutes}-${seconds}-Z`;
  const slug = caption ? slugifyCaption(caption) : "";
  return slug ? `${base}-${slug}.jpg` : `${base}.jpg`;
}
