export const metadata = { title: 'Chính sách bảo mật — ZaloMask' }

export default function PrivacyPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-bold">Chính sách bảo mật</h1>
      <p className="mt-4 text-gray-600">ZaloMask tôn trọng quyền riêng tư của người dùng và chỉ thu thập dữ liệu cần thiết để vận hành dịch vụ.</p>

      <div className="mt-8 space-y-4 text-sm leading-7 text-gray-700">
        <p>1. Dữ liệu thu thập có thể bao gồm email, thông tin license, và thông tin phiên hoạt động thiết bị phục vụ xác thực license.</p>
        <p>2. Dữ liệu thanh toán được xử lý qua cổng trung gian; hệ thống không lưu thông tin đăng nhập ngân hàng của bạn.</p>
        <p>3. Dữ liệu được dùng cho mục đích vận hành, bảo mật, và hỗ trợ khách hàng.</p>
        <p>4. Chúng tôi không bán dữ liệu cá nhân cho bên thứ ba.</p>
        <p>5. Bạn có thể liên hệ đội ngũ hỗ trợ để yêu cầu kiểm tra hoặc cập nhật dữ liệu liên quan tài khoản của mình.</p>
      </div>
    </div>
  )
}
