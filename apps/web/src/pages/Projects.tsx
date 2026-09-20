import { useEffect, useState } from "react";
import { Button, Card, Form, Input, List, Modal, Typography, App as AntApp, Tag } from "antd";
import { Link, useNavigate } from "react-router";
import { api } from "../api/client";
import { useAuth } from "../store/auth";

interface ProjectRow {
  id: string;
  key: string;
  name: string;
  description: string;
  role: string;
  createdAt: string;
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const { message } = AntApp.useApp();

  const load = () => api.get<{ projects: ProjectRow[] }>("/projects").then((d) => setProjects(d.projects));
  useEffect(() => {
    load().catch((e) => message.error(e.message));
  }, []);

  return (
    <div style={{ maxWidth: 860, margin: "40px auto", padding: "0 16px" }}>
      <Card
        title={<Typography.Title level={3} style={{ margin: 0 }}>OpenBIM Hub</Typography.Title>}
        extra={
          <Button
            onClick={async () => {
              await logout();
              navigate("/login");
            }}
          >
            退出登录（{user?.name}）
          </Button>
        }
      >
        <div style={{ marginBottom: 16, display: "flex", justifyContent: "space-between" }}>
          <Typography.Text type="secondary">我的项目（协同 BIM 平台 · Apache-2.0 开源）</Typography.Text>
          <Button type="primary" onClick={() => setOpen(true)}>
            新建项目
          </Button>
        </div>
        <List
          dataSource={projects}
          locale={{ emptyText: "还没有项目，点击右上角新建" }}
          renderItem={(p) => (
            <List.Item
              style={{ cursor: "pointer" }}
              onClick={() => navigate(`/projects/${p.id}`)}
              actions={[<Link key="open" to={`/projects/${p.id}`} onClick={(e) => e.stopPropagation()}>打开</Link>]}
            >
              <List.Item.Meta
                title={
                  <>
                    {p.name} <Tag>{p.key}</Tag> <Tag color="blue">{p.role}</Tag>
                  </>
                }
                description={p.description || "（无描述）"}
              />
            </List.Item>
          )}
        />
      </Card>

      <Modal
        title="新建项目"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={async () => {
          try {
            const values = await form.validateFields();
            const created = await api.post<{ project: { id: string } }>("/projects", values);
            setOpen(false);
            form.resetFields();
            navigate(`/projects/${created.project.id}`);
          } catch (err) {
            if ((err as Error).name !== "ValidateError") message.error((err as Error).message);
          }
        }}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="项目名称" rules={[{ required: true }]}>
            <Input placeholder="例：市图书馆改扩建" />
          </Form.Item>
          <Form.Item
            name="key"
            label="项目标识（URL 用）"
            rules={[{ required: true, pattern: /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/, message: "3-60 位小写字母/数字/连字符" }]}
          >
            <Input placeholder="library-renovation" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
