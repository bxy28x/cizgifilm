# Çizgi Film Maratonu — Web MVP

## 1. Çalıştırma
Dosyaları bir web sunucusunda yayınla. `file://` ile açmak yerine localhost/HTTPS kullan.

Örneğin:
- VS Code Live Server
- Cloudflare Pages
- Cloudflare Workers Static Assets

## 2. YouTube Data API
Google Cloud Console'da YouTube Data API v3'ü etkinleştirip bir API key oluştur.
Uygulamadaki **Ayarlar** bölümüne anahtarı gir.

API anahtarını mümkünse sadece izin verilen HTTP referrer'larla kısıtla.

## 3. Maraton sırası
Kod round-robin çalışır:

Oggy 1
→ Esrarengiz Kasaba 1
→ Doraemon 1
→ Playlist 4 / 1
→ Oggy 2
→ Esrarengiz Kasaba 2
→ ...

Bir playlist diğerinden kısa ise mevcut bölümler bitene kadar kalan playlistler devam eder.

## 4. Reklam
`AD_VIDEO_ID` değeri `UgFdtIkDvSU` olarak ayarlanmıştır.
Varsayılan reklam arası 30 saniyedir.

Not: Bu MVP, reklam videosunu YouTube iframe içinde oynatır. YouTube'un platform kurallarına uygun kullanım için videoların ve oynatma biçiminin gerekli hak/izinlere sahip olduğundan emin ol.

## 5. TV
İlk sürüm telefondan tarayıcıyla açılıp TV'ye ekran yansıtma için uygundur.
Sonraki sürümde Google Cast/Chromecast Receiver eklenebilir.


## Bölünmüş bölümler

Tüm playlistler için otomatik olarak `(1/6)`, `(2/6)` ... gibi parçalar algılanır.
Aynı bölümün parçaları tek bir gerçek bölüm altında birleştirilir.

Örnek:

Turist Kapanı (1/6)
→ (2/6)
→ (3/6)
→ (4/6)
→ (5/6)
→ (6/6)
→ **30 sn reklam**
→ sıradaki dizinin gerçek bölümü

Bu kural sadece Esrarengiz Kasaba'ya değil, dört playlistin tamamına uygulanır.
"# cizgifilm" 
