export const metadata = { title: 'Chính sách bảo mật — ZaloMask' }

export default function PrivacyPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-bold">Chính sách bảo mật</h1>
      <p className="mt-4 text-gray-600">ZaloMask chỉ thu thập dữ liệu cần thiết để vận hành license, thanh toán và hỗ trợ khách hàng.</p>

      <div className="mt-8 space-y-4 text-sm leading-7 text-gray-700">
        <p>1. Dữ liệu có thể được lưu gồm: email đăng nhập, thông tin license, lịch sử phiên thiết bị, trạng thái thanh toán và log kỹ thuật tối thiểu.</p>
        <p>2. Hệ thống không lưu thông tin đăng nhập ngân hàng; giao dịch chuyển khoản được đối soát qua SePay và dữ liệu webhook.</p>
        <p>3. Dữ liệu được sử dụng cho mục đích: xác thực license, chống lạm dụng, hỗ trợ kỹ thuật và giải quyết tranh chấp.</p>
        <p>4. ZaloMask không bán dữ liệu cá nhân cho bên thứ ba. Dữ liệu chỉ chia sẻ khi có yêu cầu pháp lý hợp lệ.</p>
        <p>5. Người dùng có thể yêu cầu kiểm tra thông tin tài khoản và trạng thái license qua kênh hỗ trợ chính thức.</p>
        <p>6. Chúng tôi áp dụng biện pháp kỹ thuật hợp lý để bảo vệ dữ liệu, nhưng người dùng vẫn cần tự bảo mật thiết bị và tài khoản của mình.</p>
      </div>
    </div>
  )
}
