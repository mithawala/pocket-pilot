// Hands over to VS Code right away; the buttons on the page do the same if the browser holds it back.
setTimeout(() => {
  const link = document.querySelector('[data-open]');
  if (link) location.href = link.href;
}, 250);
