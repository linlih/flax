import { describe, expect, it } from 'vitest'
import { shortVenue } from './display'

describe('shortVenue', () => {
  it('uses the acronym in brackets', () => {
    expect(shortVenue('2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)')).toBe('CVPR')
    expect(shortVenue('2022 IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)')).toBe('CVPR')
  })
  it('uses the part after the dash in Springer proceedings', () => {
    expect(shortVenue('Medical Image Computing and Computer-Assisted Intervention – MICCAI 2015')).toBe('MICCAI 2015')
    expect(shortVenue('Computer Vision – ECCV 2022')).toBe('ECCV 2022')
  })
  it('knows the common conferences by name', () => {
    expect(shortVenue('Advances in Neural Information Processing Systems 35')).toBe('NeurIPS')
    expect(shortVenue('Proceedings of the 2019 Conference of the North American Chapter of the Association for Computational Linguistics: Human Language Technologies, Volume 1 (Long and Short Papers)')).toBe('NAACL')
    expect(shortVenue('Findings of the Association for Computational Linguistics: EMNLP 2024')).toBe('Findings of EMNLP 2024')
    expect(shortVenue('Proceedings of the AAAI Conference on Artificial Intelligence')).toBe('AAAI')
  })
  it('leaves everything else alone', () => {
    expect(shortVenue('Nature')).toBe('Nature')
    expect(shortVenue('arXiv')).toBe('arXiv')
    expect(shortVenue('Frontiers of Computer Science, Volume 20, Issue 12, Article 2012627 (2026)')).toBe('Frontiers of Computer Science, Volume 20, Issue 12, Article 2012627 (2026)')
    expect(shortVenue('Journal of Machine Learning Research - JMLR')).toBe('JMLR')
  })
})
