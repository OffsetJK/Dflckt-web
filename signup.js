const SUPABASE_URL = 'https://piauaqingqvfvqqwzlkg.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_s4sqRofrn4I9ZNBxtKsExw_-Qe5gTj-';
const CONSENT_VERSION = 'interest-v1-2026-08-24';

const form = document.querySelector('[data-interest-form]');

if (form) {
  const emailInput = form.querySelector('input[name="email"]');
  const zipInput = form.querySelector('input[name="zip_code"]');
  const honeypot = form.querySelector('input[name="company"]');
  const submitButton = form.querySelector('button[type="submit"]');
  const message = form.querySelector('[data-form-message]');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (honeypot && honeypot.value) return;

    const email = emailInput.value.trim();
    const zipCode = zipInput.value.trim();

    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      showMessage('Enter a valid email address.', 'error');
      return;
    }

    if (!/^\d{5}(?:-\d{4})?$/.test(zipCode)) {
      showMessage('Enter a valid U.S. ZIP code.', 'error');
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Submitting…';
    showMessage('', '');

    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/INTEREST_SIGNUPS`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_PUBLISHABLE_KEY,
          'Authorization': `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          email,
          zip_code: zipCode,
          consent_version: CONSENT_VERSION
        })
      });

      if (!response.ok) {
        throw new Error(`Signup failed with status ${response.status}`);
      }

      form.reset();
      showMessage('You’re on the DFLCKT interest list. We’ll use your ZIP only to understand where coverage is wanted.', 'success');
    } catch (error) {
      console.error(error);
      showMessage('We couldn’t save that right now. Please try again in a moment.', 'error');
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Notify me when coverage reaches my area';
    }
  });

  function showMessage(text, type) {
    message.textContent = text;
    message.className = `form-message ${type}`.trim();
  }
}
