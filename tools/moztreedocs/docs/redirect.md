# Redirects

We now have the ability to define redirects in-tree! This will allow us to
refactor and move docs around to our hearts content without needing to worry
about stale external URLs. To set up a redirect simply add a line to this file under `redirects` key:

{searchfox}`docs/config.yml`

Any request starting with the prefix on the left, will be rewritten to the prefix on the right. So for example a request to
`/testing/marionette/index.html` will be re-written to `/remote/marionette/index.html`. Only prefix redirects are supported.

The bucket serving the site can't redirect by prefix, so the redirects are
applied by the `404.html` page, which the bucket returns for any missing page.
