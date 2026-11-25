import { fail, pass, read } from './lib.mjs';
import { dialogsIn, literalProp, propAt } from '../lib/jsx-dialogs.mjs';

// -------------------------------------------------------------------------------------------------
// 592. A schema is built and edited in one editor, as frontend/README.md's *A schema has one editor*
// says. Build Schema from Catalog and the schema detail dialog each draw SchemaEditor, inside a
// <Modal size="wide" fill>, and no field of a schema beside it: a second list or a second semantic id
// is how the two came to differ. Neither dialog, nor what the editor is drawn with, styles anything
// inline but the count its list's height is worked out from: the rest is App.css's, beside the modal
// rules. The README names the editor.
// -------------------------------------------------------------------------------------------------

const COMPONENTS = 'frontend/src/components/';
const DIALOGS = ['modals/SchemaBuilderModal.jsx', 'modals/SchemaDetailModal.jsx'];
const PARTS = ['common/SchemaEditor.jsx', 'common/PropertyRange.jsx', 'common/MetricPicker.jsx', 'common/SemanticIdField.jsx', 'modals/SchemaForkModal.jsx'];
/** A field of the editor's, drawn beside it. */
const OWN_FIELD = /<(?:MetricPicker|PropertyRange|SemanticIdField|input|select|textarea)\b/g;
/** The style a caller passes on, and the custom property a count goes through. */
const STYLES = [`style={style}`, `style={readOnly ? { '--schema-metrics': names.length } : undefined}`];
const README_SAYS = '**A schema has one editor**';

export default function check() {
  const problems592 = [];
  const source = (path) => read(COMPONENTS + path).replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

  for (const path of DIALOGS) {
    const src = source(path);
    const modal = dialogsIn(src).find((d) => d.kind === 'Modal');
    if (!modal || modal.problem) { problems592.push(`${path} holds no <Modal> this check can read`); continue; }
    if (!modal.body.includes('<SchemaEditor')) problems592.push(`${path} does not draw SchemaEditor in its <Modal>`);
    if (literalProp(modal.tag, 'size') !== 'wide') problems592.push(`${path} does not open at the wide step`);
    if (!/\sfill(?:\s|>|=)/.test(modal.tag) || propAt(modal.tag, 'fill') !== -1) problems592.push(`${path} does not pass fill, which gives the metric list the height that is left`);
    for (const [field] of src.matchAll(OWN_FIELD)) problems592.push(`${path} draws ${field}> beside SchemaEditor, whose field it is`);
  }

  const editor = source('common/SchemaEditor.jsx');
  for (const field of ['<MetricPicker', '<PropertyRange', '<SemanticIdField']) {
    if (!editor.includes(field)) problems592.push(`common/SchemaEditor.jsx no longer draws ${field}>: this check reads the wrong file`);
  }
  if (!editor.includes('modal-fill')) problems592.push('common/SchemaEditor.jsx marks no child modal-fill, so the metric list does not take the height that is left');

  for (const path of [...DIALOGS, ...PARTS]) {
    let src = source(path);
    for (const known of STYLES) src = src.split(known).join('');
    for (const m of src.matchAll(/\bstyle=/g)) {
      problems592.push(`${path} styles inline (${src.slice(m.index, src.indexOf('\n', m.index)).trim()}): give it a class in App.css, beside the modal rules`);
    }
  }

  if (!read('frontend/README.md').replace(/\s+/g, ' ').includes(README_SAYS)) problems592.push(`frontend/README.md does not say: ${README_SAYS}`);

  if (problems592.length) {
    fail('A schema is not built and edited in one editor (frontend/README.md, A schema has one editor):\n' +
      problems592.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the ${DIALOGS.length} dialogs that build a schema and show a version draw SchemaEditor alone, wide, its list taking the height that is left, and none of it is styled inline`);
  }
}
