# Redirects

We now have the ability to define redirects in-tree! This will allow us to
refactor and move docs around to our hearts content without needing to worry
about stale external URLs. To set up a redirect simply add a line to this file under `redirects` key:

{searchfox}`docs/config.yml`

Any request starting with the prefix on the left, will be rewritten to the prefix on the right. So for example a request to
`/testing/marionette/index.html` will be re-written to `/remote/marionette/index.html`. Only prefix redirects are supported.

The published site has a landing page at its root and the documentation under
`/docs/`, so both sides of a redirect are relative to `/docs/`. Any other
request for a page that doesn't exist, like the pre-`/docs/` URL
`/setup/index.html`, is redirected to the same path under `/docs/`.

The bucket serving the site can't redirect by prefix, so the redirects are
applied by the `404.html` page, which the bucket returns for any missing page.
