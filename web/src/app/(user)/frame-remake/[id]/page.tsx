import { FrameRemakeWorkspace } from "./workspace";
export default async function FrameRemakeProjectPage({ params }: { params: Promise<{ id: string }> }) {
    return <FrameRemakeWorkspace id={(await params).id} />;
}
