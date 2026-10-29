// popup.js — saves freelancer profile for content-script EV computation
document.addEventListener('DOMContentLoaded', () => {
  const skill = document.getElementById('skill');
  const rate = document.getElementById('rate');
  const skillVal = document.getElementById('skillVal');
  const rateVal = document.getElementById('rateVal');

  chrome.storage.local.get(['profile'], ({ profile }) => {
    if (profile) {
      skill.value = Math.round((profile.skillLevel ?? 0.7) * 100);
      rate.value = profile.hourRate ?? 60;
      skillVal.textContent = `${skill.value}%`;
      rateVal.textContent = `£${rate.value}`;
    }
  });

  skill.addEventListener('input', () => (skillVal.textContent = `${skill.value}%`));
  rate.addEventListener('input', () => (rateVal.textContent = `£${rate.value}`));

  document.getElementById('save').addEventListener('click', () => {
    chrome.storage.local.set(
      {
        profile: {
          skillLevel: parseInt(skill.value, 10) / 100,
          hourRate: parseInt(rate.value, 10),
        },
      },
      () => {
        const btn = document.getElementById('save');
        btn.textContent = 'Saved ✓';
        btn.disabled = true;
        setTimeout(() => {
          btn.textContent = 'Save profile';
          btn.disabled = false;
        }, 1200);
      },
    );
  });
});
