/* replaced by maintenance placeholder because original did not look like a netlify function */
exports.handler = async function (event) {
  return {
    statusCode: 500,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'placeholder - original function did not export handler' })
  };
};
