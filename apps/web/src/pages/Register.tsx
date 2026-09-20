import { Button, Card, Form, Input, Typography, App as AntApp } from "antd";
import { Link, useNavigate } from "react-router";
import { useAuth } from "../store/auth";

export default function RegisterPage() {
  const navigate = useNavigate();
  const register = useAuth((s) => s.register);
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
      <Card style={{ width: 380 }} title={<Typography.Title level={4} style={{ margin: 0 }}>注册 OpenBIM Hub</Typography.Title>}>
        <Form
          layout="vertical"
          onFinish={async (values) => {
            try {
              await register(values.email, values.name, values.password);
              navigate("/");
            } catch (err) {
              message.error((err as Error).message);
            }
          }}
        >
          <Form.Item name="email" label="邮箱" rules={[{ required: true, type: "email" }]}>
            <Input />
          </Form.Item>
          <Form.Item name="name" label="姓名" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码（至少 8 位）"
            rules={[{ required: true, min: 8 }]}
          >
            <Input.Password />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            注册
          </Button>
          <div style={{ marginTop: 12, textAlign: "center" }}>
            已有账号？<Link to="/login">登录</Link>
          </div>
        </Form>
      </Card>
    </div>
  );
}
