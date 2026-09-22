<!--
  The body of a GitHub Release, written for an OPERATOR deciding whether this release matters to
  them -- not assembled from commit subjects. docs/releases.md promises these headings, so keep
  them and their order; delete a section only when it is genuinely empty.

  `gh release create v<version> --notes-file <this, filled in>`
-->

## Action required before upgrading

<!--
  Anything that is not `helm upgrade` with the values file the site already has: a values key that
  must be set, a backup that must be taken first, a manual step. DELETE THIS SECTION ENTIRELY when
  there is nothing -- its absence is the answer, and "None" reads as an oversight.
-->

## Deprecated

<!-- What still works, what replaces it, and the release it goes away in. -->

## Fixed

<!-- Each entry names the symptom a site would have seen, not the change that fixed it. -->

## Added

<!-- New capability, and the values key that turns it on. Off by default unless stated. -->

## Images and chart

```
ghcr.io/harri-llewelyn/acs-cymru/aber  <version>   (chart)
```

<!--
  The ten images publish at the same version. The release workflow's job summary lists them; paste
  it here so a pull can be checked against the release.
-->
