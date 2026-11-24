const navToggle = document.getElementById('nav-toggle');
const navMenu = document.getElementById('nav-menu');

navToggle.addEventListener('click', () => {
  navMenu.classList.toggle('show');

  // Hide the hamburger when menu is open
  if(navMenu.classList.contains('show')) {
    navToggle.style.display = 'none';
  } else {
    navToggle.style.display = 'block';
  }
});

// The Admin menu is a <details>, so it already opens and closes on its own.
// What it does not do is close when you decide against it: it hangs over the
// page, and clicking the page behind it or pressing Escape is how anybody
// expects a menu to go away.
const dropdowns = () => document.querySelectorAll('.nav-dropdown details[open]');

document.addEventListener('click', (e) => {
  dropdowns().forEach((menu) => {
    if (!menu.contains(e.target)) menu.open = false;
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  dropdowns().forEach((menu) => {
    menu.open = false;
    // back to the heading, or the focus is left on a link that is now hidden
    menu.querySelector('summary')?.focus();
  });
});
