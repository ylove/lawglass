/**
 * One-line notes shown where a part of the bill has no example. They are written here, by our
 * code, never by the model: a model that decides "no example" must not also get to say why.
 * Kept free of Node imports so the web client can show the same sentence.
 */

/** The brief said no one-person example fits this part (offices, reports, studies...). */
export const NO_EXAMPLE_NOTE =
  "This part sets up rules or reports, and there's no one-person example to show.";

/** An example was attempted but could not be drawn from the text with every claim cited. */
export const EXAMPLE_FAILED_NOTE =
  "We couldn't draw an example from this part that stays true to its text, so we're not showing one.";
