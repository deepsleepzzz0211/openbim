import { useEffect, useState } from "react";
import {
  Alert, Button, Card, Empty, Input, List, Modal, Progress, Space, Tag, Typography, Upload, App as AntApp,
} from "antd";
import { Link, useParams } from "react-router";
import { UploadOutlined } from "@ant-design/icons";
import { api, downloadToFile, uploadVersion } from "../api/client";

interface VersionRow {
  id: string;
  versionNumber: number;
  status: "PENDING" | "PROCESSING" | "READY" | "FAILED";
  progress: number;
  errorCode: string | null;
  schema: string | null;
  statsJson: string | null;
  originalName: string;
  sizeBytes: number;
  createdAt: string;
}

interface ModelRow {
  id: string;
  name: string;
  description: string;
  versions: VersionRow[];
}

const STATUS_TAG: Record<string, { color: string; text: string }> = {
  PENDING: { color: "default", text: "排队中" },
  PROCESSING: { color: "processing", text: "转换中" },
  READY: { color: "success", text: "就绪" },
  FAILED: { color: "error", text: "失败" },
};

export default function ModelsPage() {
  const { projectId } = useParams();
  const { message } = AntApp.useApp();
  const [models, setModels] = useState<ModelRow[]>([]);
  const [newModel, setNewModel] = useState(false);
  const [name, setName] = useState("");
  const [progress, setProgress] = useState<number | null>(null);

  const load = () =>
    api.get<{ models: ModelRow[] }>(`/projects/${projectId}/models`).then((d) => setModels(d.models));

  useEffect(() => {
    load().catch((e) => message.error(e.message));
    const timer = setInterval(() => {
      load().catch(() => undefined);
    }, 5000);
    return () => clearInterval(timer);
  }, [projectId]);

  const upload = async (modelId: string, file: File) => {
    try {
      setProgress(0);
      await uploadVersion(modelId, file, (pct) => setProgress(pct));
      message.success("上传完成，正在后台转换");
      await load();
    } catch (err) {
      message.error(`上传失败：${(err as Error).message}`);
    } finally {
      setProgress(null);
    }
  };

  return (
    <div style={{ maxWidth: 960, margin: "40px auto", padding: "0 16px" }}>
      <Card
        title={
          <Space>
            <Link to="/">← 项目</Link>
            <Typography.Title level={3} style={{ margin: 0 }}>模型</Typography.Title>
          </Space>
        }
        extra={
          <Button type="primary" onClick={() => setNewModel(true)}>
            新建模型
          </Button>
        }
      >
        {progress !== null && <Progress percent={progress} style={{ marginBottom: 16 }} />}
        {models.length === 0 && <Empty description="还没有模型，先新建一个模型分支" />}
        {models.map((m) => (
          <Card
            key={m.id}
            type="inner"
            title={m.name}
            style={{ marginBottom: 16 }}
            extra={
              <Upload
                showUploadList={false}
                beforeUpload={(file) => {
                  if (!file.name.toLowerCase().endsWith(".ifc")) {
                    message.error("仅支持 .ifc 文件");
                    return Upload.LIST_IGNORE;
                  }
                  void upload(m.id, file);
                  return false;
                }}
              >
                <Button icon={<UploadOutlined />}>上传 IFC 新版本</Button>
              </Upload>
            }
          >
            <List
              size="small"
              dataSource={m.versions}
              locale={{ emptyText: "暂无版本" }}
              renderItem={(v) => {
                const tag = STATUS_TAG[v.status];
                const stats = v.statsJson ? (JSON.parse(v.statsJson) as { elements?: number; triangles?: number }) : {};
                return (
                  <List.Item
                    actions={
                      v.status === "READY"
                        ? [
                            <Link key="view" to={`/projects/${projectId}/models/${m.id}?version=${v.id}`}>
                              三维查看
                            </Link>,
                            <a
                              key="dl"
                              onClick={(e) => {
                                e.preventDefault();
                                void downloadToFile(`/versions/${v.id}/file/original`, v.originalName);
                              }}
                            >
                              下载 IFC
                            </a>,
                          ]
                        : v.status === "FAILED"
                          ? [
                              <Button
                                key="retry"
                                size="small"
                                onClick={async () => {
                                  await api.post(`/versions/${v.id}/reconvert`);
                                  message.info("已重新排队");
                                  load();
                                }}
                              >
                                重试
                              </Button>,
                            ]
                          : []
                    }
                  >
                    <Space size="middle">
                      <span>v{v.versionNumber}</span>
                      <Tag color={tag.color}>{tag.text}{v.status === "PROCESSING" && v.progress ? ` ${v.progress}%` : ""}</Tag>
                      {v.schema && <Tag>{v.schema}</Tag>}
                      <Typography.Text type="secondary">
                        {v.originalName} · {(v.sizeBytes / 1024).toFixed(0)} KB
                        {stats.elements !== undefined && ` · ${stats.elements} 构件 · ${stats.triangles} 三角面`}
                      </Typography.Text>
                    </Space>
                    {v.status === "FAILED" && (
                      <Alert type="error" showIcon message={`转换失败：${v.errorCode ?? "UNKNOWN"}`} style={{ marginTop: 8 }} />
                    )}
                  </List.Item>
                );
              }}
            />
          </Card>
        ))}
      </Card>

      <Modal
        title="新建模型"
        open={newModel}
        onCancel={() => setNewModel(false)}
        onOk={async () => {
          if (!name.trim()) return;
          await api.post(`/projects/${projectId}/models`, { name });
          setName("");
          setNewModel(false);
          load();
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例：建筑专业 / 结构专业" />
      </Modal>
    </div>
  );
}
