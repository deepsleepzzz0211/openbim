import { Button, Card, Form, Input, Typography, App as AntApp } from "antd";
import { Link, useNavigate } from "react-router";
import { useAuth } from "../store/auth";

export default function LoginPage() {
  const navigate = useNavigate();
  const login = useAuth((s) => s.login);
  const { message } = AntApp.useApp();

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(160deg, #0b1622 0%, #12293e 100%)",
      }}
    >
      <Card style={{ width: 380 }} title={<Typography.Title level={4} style={{ margin: 0 }}>OpenBIM Hub 登录</Typography.Title>}>
        <Form
          layout="vertical"
          onFinish={async (values) => {
            try {
              await login(values.email, values.password);
              navigate("/");
            } catch (err) {
              message.error((err as Error).message);
            }
          }}
        >
          <Form.Item name="email" label="邮箱" rules={[{ required: true, type: "email" }]}>
            <Input placeholder="you@example.com" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true }]}>
            <Input.Password />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            登录
          </Button>
          <div style={{ marginTop: 12, textAlign: "center" }}>
            还没有账号？<Link to="/register">注册</Link>
          </div>
        </Form>
      </Card>
    </div>
  );
}
