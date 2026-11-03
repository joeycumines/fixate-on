// .prettierrc.cjs — gts init's .prettierrc.js, renamed for "type": "module".
// The whole style layer is gts's own .prettierrc.json: single quotes, no
// bracket spacing, trailing commas, arrow parens avoided.
module.exports = {
  ...require('gts/.prettierrc.json'),
};
