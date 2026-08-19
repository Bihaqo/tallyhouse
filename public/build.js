// Prints the commit this instance is running into the footer, linked to that
// commit on GitHub.
//
// It is the shortest path from "I am looking at the site" to "I am looking at
// the code that served it" — one click, no searching for a repo, and it names
// the exact revision rather than a branch that has moved since. Added by script
// rather than written into each page so there is one place it can be wrong.
//
// Silent on every failure: an instance whose platform never said which commit
// it built (a plain `git clone` and `node server.js`) has nothing truthful to
// print here, and a footer is not worth an error message.
(async () => {
  // The last footer on the page, because onboarding has two and the one that
  // carries the About/Privacy links — the page's small print — is the lower.
  const feet = document.querySelectorAll('.card-footer');
  const foot = feet[feet.length - 1];
  if (!foot) return;

  let build;
  try {
    const res = await fetch('/version', { headers: { Accept: 'application/json' } });
    if (!res.ok) return;
    build = await res.json();
  } catch {
    return;
  }
  if (!build || !build.shortCommit) return;

  // The commit link is only ever http(s), and the text is only ever set as
  // text: both values reach here from a deployment's own environment
  // (SOURCE_REPO_URL is free-form), and a footer is not the place to find out
  // that something typed into a variable can navigate or parse as markup.
  const href = /^https?:\/\//i.test(build.commitUrl || '') ? build.commitUrl : null;
  const label = document.createElement(href ? 'a' : 'span');
  if (href) {
    label.href = href;
    label.rel = 'noopener';
  }
  label.textContent = build.shortCommit;
  label.title = `Running commit ${build.commit}${build.branch ? ` of ${build.branch}` : ''}`;

  // The app page's footer holds nothing else — its About/Privacy links are up
  // in the topbar — so the separator would open the line there.
  const lead = foot.textContent.trim() ? ' · running ' : 'running ';
  foot.append(document.createTextNode(lead), label);
})();
