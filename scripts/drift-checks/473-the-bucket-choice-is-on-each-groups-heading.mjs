import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 473. The Device tab's bucket choice is on each group's heading, not in the toolbar: HistoryDevice.jsx
// draws each group's heading with HistoryGroupHead and hands it the group's `buckets`, no control
// of its own offers a bucket size, and the help and the README say where the choice is. A page that
// sends a reader to a toolbar control that is not there is worse than one with no help.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const page = read('frontend/src/components/tabs/HistoryDevice.jsx');
  const head = read('frontend/src/components/common/HistoryGroupHead.jsx');
  const problems473 = [];
  if (!/<HistoryGroupHead[\s\S]*?buckets=\{\{/.test(page)) problems473.push('HistoryDevice.jsx does not draw each group\'s heading with HistoryGroupHead and its `buckets`');
  if (!/<SegmentedControl\b/.test(head)) problems473.push('HistoryGroupHead.jsx does not draw the choice as a SegmentedControl, as the time window and the account menu\'s switches are');
  for (const [pattern, what] of [[/Choose the bucket size/, 'a popover named "Choose the bucket size"'], [/function BucketChoice/, 'a BucketChoice toolbar control'], [/Buckets: \$\{/, 'a "Buckets: …" toolbar button']]) {
    if (pattern.test(page)) problems473.push(`HistoryDevice.jsx still has ${what}: the choice is on each group's heading`);
  }
  if (/Select \*\*Buckets\*\*/.test(read('help/pages/history.md'))) problems473.push('help/pages/history.md still says to select Buckets, a toolbar control that is gone');
  if (!read('help/pages/history.md').includes('use the switch at the right-hand end of a group\'s heading')) {
    problems473.push('help/pages/history.md does not say the bucket switch is at the right-hand end of a group\'s heading');
  }
  if (!read('frontend/README.md').includes('The toolbar has no Buckets\n  control')) {
    problems473.push('frontend/README.md does not say the toolbar has no Buckets control');
  }
  if (problems473.length) {
    fail('the bucket choice and the docs disagree about where it is:\n' + problems473.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('the Device tab\'s bucket choice is a SegmentedControl on each group\'s heading, none in the toolbar, and the help and the README say so');
  }
}
