export const metadata = { title: 'Điều khoản sử dụng — ZaloMask' }

export default function TermsPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-bold">Điều khoản sử dụng</h1>
      <p className="mt-4 text-gray-600">Bằng việc sử dụng ZaloMask, bạn đồng ý tuân thủ các điều khoản dưới đây.</p>

      <div className="mt-8 space-y-4 text-sm leading-7 text-gray-700">
        <p>1. License chỉ được active trên một máy tại một thời điểm. Đăng nhập trên máy mới có thể làm phiên cũ bị ngắt.</p>
        <p>2. Bạn chịu trách nhiệm bảo mật license key và tài khoản đăng nhập của mình.</p>
        <p>3. Không sử dụng phần mềm cho mục đích vi phạm pháp luật hoặc chính sách nền tảng bên thứ ba.</p>
        <p>4. Dịch vụ có thể được cập nhật để cải thiện bảo mật và độ ổn định mà không cần báo trước.</p>
        <p>5. Nếu cần hỗ trợ hoặc xử lý thanh toán, vui lòng liên hệ kênh hỗ trợ chính thức của ZaloMask.</p>
      </div>
    </div>
  )
}
