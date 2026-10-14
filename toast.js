/* One short notice at a time. A notice shown while a dialog is open must live inside that dialog: the page behind a modal is
   inert and the top layer would hide it. */
(() => {
  'use strict';
  function create({node, document, setTimer = setTimeout, clearTimer = clearTimeout, ms = 4500}) {
    let timer;
    return function toast(message) {
      const host = Array.from(document.querySelectorAll('dialog[open]')).at(-1) || document.body;
      host.append(node);
      node.textContent = message; node.hidden = false;
      clearTimer(timer); timer = setTimer(() => { node.hidden = true; }, ms);
    };
  }
  window.MinitandemToast = {create};
})();
