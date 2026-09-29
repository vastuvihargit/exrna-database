import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Shown in place of a Node-only administrative tool when the page is served by the Cloudflare
 * Worker. The tab is already hidden there; this covers a bookmark or a typed URL. The API
 * behind the tool answers `501 NODE_ONLY_OPERATION` regardless (`server/http/node-only.ts`).
 */
export function NodeOnlyNotice({ feature }: { feature: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{feature} is not available on this deployment</CardTitle>
        <CardDescription>
          This tool moves data off the legacy server deployment (its database and local disk), and
          runs there only. This deployment stores files in the company Shared Drive and has nothing
          for it to move.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
