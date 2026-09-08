import { BangbangWorkspace } from "./workspace";
export default async function BangbangProjectPage({ params }: { params: Promise<{ id: string }> }) {
    return <BangbangWorkspace id={(await params).id} />;
}
