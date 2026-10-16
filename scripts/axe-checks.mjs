// The complete result stays in the CI artifact, including lower-impact and incomplete findings.
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
export const blockingViolations=result=>result.violations.filter(item=>['serious','critical'].includes(item.impact));
export function assertAccessible(reports){
  const failures=reports.flatMap(report=>blockingViolations(report).map(item=>`${report.state}: ${item.impact} ${item.id} (${item.nodes.length} nodes)`));
  if(failures.length)throw Error('Accessibility violations:\n'+failures.join('\n'));
}
export async function scanPage(page,state){
  await page.addScriptTag({path:require.resolve('axe-core/axe.min.js')});
  const result=await page.evaluate(async()=>window.axe.run(document));
  for(const violation of result.violations){
    console.log(`[axe] ${state}: ${violation.impact} ${violation.id}: ${violation.help}`);
    for(const node of violation.nodes)console.log('  '+node.target.join(', '));
  }
  for(const item of result.incomplete)console.log(`[axe] ${state}: needs review ${item.id} (${item.nodes.length} nodes)`);
  console.log(`[axe] ${state}: ${result.violations.length} violations, ${result.incomplete.length} incomplete checks`);
  return {state,...result};
}
