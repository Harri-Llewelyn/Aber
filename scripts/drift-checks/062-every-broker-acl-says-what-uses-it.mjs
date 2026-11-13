import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 62. Every broker ACL says what uses it.
//
// Each ACL in mosquitto/dynsec-roles.json carries a `why` naming what exercises it. Presence only,
// never truth: no check can say an ACL is unused (mosquitto/README.md, "No check finds an unused
// ACL"), so the sentence is the control. Writing "the Directory read is used by —" and finding no
// end to it is how an over-grant is noticed. The reconcile strips `why` before the plugin sees it.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const policy = JSON.parse(read('mosquitto/dynsec-roles.json'));
  const acls = (policy.roles || []).flatMap((role) => (role.acls || []).map((acl) => ({ role: role.rolename, acl })));
  // Two words at least: a placeholder ("x", "TODO") is presence without a sentence.
  const said = (why) => typeof why === 'string' && why.trim().split(/\s+/).length >= 2;
  const missing = acls.filter(({ acl }) => !said(acl.why));
  if (!said('ingestion.py subscribes') || said('TODO') || said(undefined)) {
    fail('check 62 no longer tells a sentence from a placeholder; its own fixtures disagree with it');
  } else if (acls.length === 0) {
    fail('mosquitto/dynsec-roles.json declares no ACL for check 62 to read; the file changed shape');
  } else if (missing.length) {
    fail(
      `${missing.length} broker ACL(s) in mosquitto/dynsec-roles.json say nothing of what uses them: ` +
        missing.map(({ role, acl }) => `${role} ${acl.acltype} ${acl.topic}`).join('; ') +
        '.\n      Give each a `why` naming the code or the process that exercises it. If nothing ' +
        'does, that is the finding.'
    );
  } else {
    pass(`all ${acls.length} broker ACLs in mosquitto/dynsec-roles.json say what uses them`);
  }
}
