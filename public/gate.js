// The code goes to /k/<code>, which sets a cookie and redirects; it is never stored by this page.
const msg = document.getElementById('msg');
if (new URLSearchParams(location.search).has('bad')) msg.textContent = 'That code did not work. Check the link you were given.';
document.getElementById('f').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = document.getElementById('code').value.trim().toLowerCase();
  if (!/^[a-z0-9-]{8,64}$/.test(code)) { msg.textContent = 'That does not look like an access code.'; return; }
  location.href = `/k/${encodeURIComponent(code)}?to=go`;
});
