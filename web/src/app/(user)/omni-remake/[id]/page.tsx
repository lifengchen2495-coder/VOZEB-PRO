import { OmniWorkspace } from "./workspace";
export default async function OmniProjectPage({ params }: { params: Promise<{ id: string }> }) {
    return <OmniWorkspace id={(await params).id} />;
}
